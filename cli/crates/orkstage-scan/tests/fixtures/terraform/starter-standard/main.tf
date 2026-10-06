# The platform's built-in "starter-standard" template, written as plain Terraform for AWS.
# The scan of this directory must reproduce the same logical resources and connectivity.

terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 6.0" }
  }
}

variable "api_replicas" {
  type    = number
  default = 1
}

variable "api_image" {
  type    = string
  default = "123456789012.dkr.ecr.us-east-1.amazonaws.com/sample-api:1.4.0"
}

locals {
  name     = "starter"
  api_port = 8080
}

data "aws_availability_zones" "available" {}

# ── network ──────────────────────────────────────────────────────────────────
resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = "${local.name}-vpc" }
}

resource "aws_subnet" "public_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.0.0/24"
  availability_zone = "us-east-1a"
}

resource "aws_subnet" "public_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.1.0/24"
  availability_zone = "us-east-1b"
}

resource "aws_subnet" "private_a" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.10.0/24"
  availability_zone = "us-east-1a"
}

resource "aws_subnet" "private_b" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.20.11.0/24"
  availability_zone = "us-east-1b"
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

resource "aws_security_group" "services" {
  name   = "${local.name}-services"
  vpc_id = aws_vpc.main.id
}

# ── registry ─────────────────────────────────────────────────────────────────
resource "aws_ecr_repository" "registry" {
  name                 = "${local.name}/apps"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
}

# ── data ─────────────────────────────────────────────────────────────────────
resource "aws_db_subnet_group" "db" {
  name       = "${local.name}-db"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

resource "aws_db_instance" "database" {
  identifier              = "${local.name}-db"
  engine                  = "postgres"
  engine_version          = "17.4"
  instance_class          = "db.t4g.small"
  allocated_storage       = 20
  multi_az                = false
  backup_retention_period = 7
  db_subnet_group_name    = aws_db_subnet_group.db.name
  publicly_accessible     = false
  skip_final_snapshot     = true
}

resource "aws_elasticache_subnet_group" "cache" {
  name       = "${local.name}-cache"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

resource "aws_elasticache_replication_group" "cache" {
  replication_group_id = "${local.name}-cache"
  description          = "API cache"
  engine               = "valkey"
  node_type            = "cache.t4g.micro"
  num_cache_clusters   = 1
  subnet_group_name    = aws_elasticache_subnet_group.cache.name
}

resource "aws_sqs_queue" "messaging_dlq" {
  name = "${local.name}-messaging-dlq"
}

resource "aws_sqs_queue" "messaging" {
  name = "${local.name}-messaging"
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.messaging_dlq.arn
    maxReceiveCount     = 5
  })
}

# ── compute ──────────────────────────────────────────────────────────────────
resource "aws_ecs_cluster" "main" {
  name = local.name
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  container_definitions = jsonencode([{
    name         = "api"
    image        = var.api_image
    essential    = true
    portMappings = [{ containerPort = local.api_port, protocol = "tcp" }]
    environment = [
      { name = "DATABASE_HOST", value = aws_db_instance.database.address },
      { name = "REDIS_HOST", value = aws_elasticache_replication_group.cache.primary_endpoint_address },
      { name = "QUEUE_URL", value = aws_sqs_queue.messaging.url },
    ]
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  container_definitions = jsonencode([{
    name      = "worker"
    image     = "123456789012.dkr.ecr.us-east-1.amazonaws.com/sample-worker:1.4.0"
    essential = true
    environment = [
      { name = "DATABASE_URL", value = "postgres://app@${aws_db_instance.database.address}:5432/app" },
      { name = "QUEUE_URL", value = aws_sqs_queue.messaging.url },
    ]
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_replicas
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_groups = [aws_security_group.services.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = local.api_port
  }
}

resource "aws_ecs_service" "worker" {
  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets = [aws_subnet.private_a.id, aws_subnet.private_b.id]
  }
}

# ── ingress and DNS ──────────────────────────────────────────────────────────
resource "aws_lb" "ingress" {
  name               = "${local.name}-alb"
  load_balancer_type = "application"
  internal           = false
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name}-api"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id
  health_check {
    path = "/health"
  }
}

resource "aws_acm_certificate" "main" {
  domain_name       = "app.example.com"
  validation_method = "DNS"
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.ingress.arn
  port              = 443
  protocol          = "HTTPS"
  certificate_arn   = aws_acm_certificate.main.arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_route53_zone" "main" {
  name = "example.com"
}

resource "aws_route53_record" "app" {
  zone_id = aws_route53_zone.main.zone_id
  name    = "app.example.com"
  type    = "A"
  alias {
    name                   = aws_lb.ingress.dns_name
    zone_id                = aws_lb.ingress.zone_id
    evaluate_target_health = true
  }
}

# Not mappable: reported as unmapped with a reason.
module "alarms" {
  source  = "terraform-aws-modules/cloudwatch/aws//modules/metric-alarm"
  version = "~> 5.0"
}
