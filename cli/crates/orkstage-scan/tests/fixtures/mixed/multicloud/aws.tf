resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_ecr_repository" "apps" {
  name = "apps"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "api"
  requires_compatibilities = ["FARGATE"]
  cpu                      = 512
  memory                   = 1024
  container_definitions = jsonencode([{
    name         = "api"
    image        = "acme/api:1"
    portMappings = [{ containerPort = 8080 }]
    environment = [
      { name = "DB_HOST", value = azurerm_postgresql_flexible_server.data.fqdn },
      { name = "BUCKET", value = oci_objectstorage_bucket.files.name },
    ]
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 2
  network_configuration {
    subnets          = []
    assign_public_ip = true
  }
}
