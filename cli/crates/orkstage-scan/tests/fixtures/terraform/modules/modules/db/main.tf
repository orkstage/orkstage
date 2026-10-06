variable "name" { type = string }
variable "instance_class" { default = "db.t4g.micro" }
variable "multi_az" { default = false }

resource "aws_db_instance" "this" {
  identifier              = var.name
  engine                  = "postgres"
  engine_version          = "16.6"
  instance_class          = var.instance_class
  allocated_storage       = 100
  multi_az                = var.multi_az
  backup_retention_period = 14
}

output "host" { value = aws_db_instance.this.address }
