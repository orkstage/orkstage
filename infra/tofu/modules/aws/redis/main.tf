# Logical "cache.redis" on ElastiCache (Valkey, Redis OSS–compatible).

variable "name" { type = string } # <= 40 chars
variable "node_type" { type = string }
variable "replicas" { type = number }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "subnet_ids" { type = list(string) }

resource "aws_elasticache_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "cache" {
  # A prefix plus create-before-destroy lets a replacement (e.g. a new VPC) attach the new
  # group before the old one is deleted; a fixed name would collide, and deleting first fails
  # while network interfaces still use the group.
  name_prefix = "${var.name}-cache-"
  description = "Cache ${var.name}"
  vpc_id      = var.vpc_id
  ingress {
    from_port   = 6379
    to_port     = 6379
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id       = var.name
  description                = "OrkStage cache ${var.name}"
  engine                     = "valkey"
  node_type                  = var.node_type
  num_cache_clusters         = 1 + var.replicas
  automatic_failover_enabled = var.replicas > 0
  multi_az_enabled           = var.replicas > 0
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.cache.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = false
}

output "kind" { value = "cache.redis" }
output "host" { value = aws_elasticache_replication_group.this.primary_endpoint_address }
output "port" { value = 6379 }
output "replication_group_id" { value = aws_elasticache_replication_group.this.id }
