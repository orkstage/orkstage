resource "aws_db_instance" "orders" {
  identifier        = "orders"
  engine            = "postgres"
  engine_version    = "17"
  instance_class    = "db.t4g.medium"
  allocated_storage = 50
}

resource "aws_ecs_service" "app" {
  name          = "app"
  desired_count = 2
  launch_type   = "EC2"
}
