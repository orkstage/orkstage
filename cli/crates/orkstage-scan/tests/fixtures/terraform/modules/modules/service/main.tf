variable "name" { type = string }
variable "image" { type = string }
variable "cpu" { default = 0.25 }
variable "memory" { default = 512 }
variable "replicas" { default = 1 }
variable "port" { default = null }
variable "environment" { default = {} }

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.cpu * 1024
  memory                   = var.memory
  container_definitions = jsonencode([{
    name         = var.name
    image        = var.image
    portMappings = var.port == null ? [] : [{ containerPort = var.port }]
    environment  = [for k, v in var.environment : { name = k, value = v }]
  }])
}

resource "aws_ecs_service" "this" {
  name            = var.name
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.replicas
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
  }
}

output "service_name" { value = aws_ecs_service.this.name }
