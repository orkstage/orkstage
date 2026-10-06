# Logical "compute.container-service" on Amazon ECS. Capacity is a choice, not a different
# product: FARGATE, FARGATE_SPOT or EC2 (an Auto Scaling group registered as a capacity provider).

variable "name" { type = string }
variable "capacity" {
  type    = string
  default = "FARGATE"
  validation {
    condition     = contains(["FARGATE", "FARGATE_SPOT", "EC2"], var.capacity)
    error_message = "capacity must be FARGATE, FARGATE_SPOT or EC2."
  }
}
variable "image" { type = string }
variable "cpu" { type = number }        # vCPU, e.g. 0.25
variable "memory_mib" { type = number }
variable "replicas" { type = number }
variable "port" {
  type    = number
  default = null
}
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "subnet_ids" { type = list(string) }
variable "assign_public_ip" {
  type    = bool
  default = false
}
# Plain configuration (hosts, ports, URLs). Never secret values.
variable "environment" {
  type    = map(string)
  default = {}
}
# NAME => Secrets Manager ARN, injected by ECS at start; values never pass through OpenTofu.
variable "secrets" {
  type    = map(string)
  default = {}
}
variable "target_group_arn" {
  type    = string
  default = ""
}
variable "lb_sg_id" {
  type    = string
  default = ""
}
variable "log_retention_days" {
  type    = number
  default = 14
}
# EC2 capacity only. Empty = latest ECS-optimized Amazon Linux 2023 AMI from SSM.
variable "ec2_ami_id" {
  type    = string
  default = ""
}
variable "ec2_instance_type" {
  type    = string
  default = "t3.small"
}

data "aws_region" "current" {}

locals {
  fargate   = var.capacity != "EC2"
  task_cpu  = tostring(max(256, floor(var.cpu * 1024)))
  container = var.name
  env       = [for k, v in var.environment : { name = k, value = v }]
  secrets   = [for k, v in var.secrets : { name = k, valueFrom = v }]
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/orkstage/${var.name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "execution" {
  name = substr("${var.name}-exec", 0, 64)
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Least privilege: the task may read exactly the secrets it references.
resource "aws_iam_role_policy" "secrets" {
  count = length(var.secrets) > 0 ? 1 : 0
  name  = "read-referenced-secrets"
  role  = aws_iam_role.execution.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = values(var.secrets) }]
  })
}

resource "aws_security_group" "service" {
  # A prefix plus create-before-destroy lets a replacement (e.g. a new VPC) attach the new
  # group before the old one is deleted; a fixed name would collide, and deleting first fails
  # while network interfaces still use the group.
  name_prefix = "${var.name}-svc-"
  description = "Service ${var.name}"
  vpc_id      = var.vpc_id
  ingress {
    from_port   = coalesce(var.port, 0)
    to_port     = coalesce(var.port, 0)
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

# ── EC2 capacity (only when capacity = EC2) ──────────────────────────────────
data "aws_ssm_parameter" "ecs_ami" {
  count = var.capacity == "EC2" && var.ec2_ami_id == "" ? 1 : 0
  name  = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

resource "aws_iam_role" "instance" {
  count = var.capacity == "EC2" ? 1 : 0
  name  = substr("${var.name}-ec2", 0, 64)
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole" }]
  })
}

resource "aws_iam_role_policy_attachment" "instance" {
  count      = var.capacity == "EC2" ? 1 : 0
  role       = aws_iam_role.instance[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_instance_profile" "instance" {
  count = var.capacity == "EC2" ? 1 : 0
  name  = substr("${var.name}-ec2", 0, 64)
  role  = aws_iam_role.instance[0].name
}

resource "aws_launch_template" "ec2" {
  count         = var.capacity == "EC2" ? 1 : 0
  name_prefix   = substr("${var.name}-", 0, 100)
  image_id      = var.ec2_ami_id != "" ? var.ec2_ami_id : nonsensitive(data.aws_ssm_parameter.ecs_ami[0].value)
  instance_type = var.ec2_instance_type
  iam_instance_profile { arn = aws_iam_instance_profile.instance[0].arn }
  vpc_security_group_ids = [aws_security_group.service.id]
  metadata_options { http_tokens = "required" }
  user_data = base64encode("#!/bin/bash\necho ECS_CLUSTER=${var.name} >> /etc/ecs/ecs.config\n")
}

resource "aws_autoscaling_group" "ec2" {
  count               = var.capacity == "EC2" ? 1 : 0
  name_prefix         = substr("${var.name}-", 0, 200)
  vpc_zone_identifier = var.subnet_ids
  min_size            = 1
  max_size            = max(1, var.replicas)
  desired_capacity    = max(1, var.replicas)
  launch_template {
    id      = aws_launch_template.ec2[0].id
    version = "$Latest"
  }
  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }
}

resource "aws_ecs_capacity_provider" "ec2" {
  count = var.capacity == "EC2" ? 1 : 0
  name  = substr("${var.name}-cp", 0, 255)
  auto_scaling_group_provider {
    auto_scaling_group_arn = aws_autoscaling_group.ec2[0].arn
    managed_scaling { status = "ENABLED" }
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = var.capacity == "EC2" ? [aws_ecs_capacity_provider.ec2[0].name] : ["FARGATE", "FARGATE_SPOT"]
  default_capacity_provider_strategy {
    capacity_provider = var.capacity == "EC2" ? aws_ecs_capacity_provider.ec2[0].name : var.capacity
    weight            = 1
  }
}

# ── Task and service ─────────────────────────────────────────────────────────
resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = [local.fargate ? "FARGATE" : "EC2"]
  network_mode             = "awsvpc"
  cpu                      = local.task_cpu
  memory                   = tostring(var.memory_mib)
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name         = local.container
    image        = var.image
    essential    = true
    environment  = local.env
    secrets      = local.secrets
    portMappings = var.port == null ? [] : [{ containerPort = var.port, protocol = "tcp" }]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = data.aws_region.current.region
        awslogs-stream-prefix = "app"
      }
    }
  }])
}

resource "aws_ecs_service" "this" {
  name            = var.name
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.replicas
  # Roll tasks on every service change; also required by the provider whenever the capacity
  # provider strategy is (re)applied.
  force_new_deployment = true
  capacity_provider_strategy {
    capacity_provider = var.capacity == "EC2" ? aws_ecs_capacity_provider.ec2[0].name : var.capacity
    weight            = 1
  }
  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = compact([aws_security_group.service.id, var.lb_sg_id])
    assign_public_ip = local.fargate ? var.assign_public_ip : false
  }
  dynamic "load_balancer" {
    for_each = var.target_group_arn != "" && var.port != null ? [1] : []
    content {
      target_group_arn = var.target_group_arn
      container_name   = local.container
      container_port   = var.port
    }
  }
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  depends_on = [aws_ecs_cluster_capacity_providers.this]
}

output "kind" { value = "compute.container-service" }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "service_name" { value = aws_ecs_service.this.name }
output "service_arn" { value = aws_ecs_service.this.id }
output "log_group" { value = aws_cloudwatch_log_group.this.name }
output "image" { value = var.image }
output "capacity" { value = var.capacity }
