# Logical "database.postgresql" on Amazon RDS. The master password is generated ephemerally and
# written only through write-only attributes: it never appears in OpenTofu state (spec §17, §74).

variable "name" { type = string }
variable "engine_version" { type = string }
variable "instance_class" { type = string }
variable "storage_gib" { type = number }
variable "multi_az" { type = bool }
variable "backup_retention_days" { type = number }
variable "production" { type = bool }
variable "vpc_id" { type = string }
variable "vpc_cidr" { type = string }
variable "subnet_ids" { type = list(string) }
variable "username" {
  type    = string
  default = "app"
}
# Bump to rotate the master password.
variable "password_version" {
  type    = number
  default = 1
}

ephemeral "random_password" "master" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "this" {
  name       = var.name
  subnet_ids = var.subnet_ids
}

resource "aws_security_group" "db" {
  # A prefix plus create-before-destroy lets a replacement (e.g. a new VPC) attach the new
  # group before the old one is deleted; a fixed name would collide, and deleting first fails
  # while network interfaces still use the group.
  name_prefix = "${var.name}-db-"
  description = "Postgres ${var.name}"
  vpc_id      = var.vpc_id
  ingress {
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_secretsmanager_secret" "credentials" {
  name                    = "${var.name}/credentials"
  recovery_window_in_days = var.production ? 30 : 0
}

resource "aws_secretsmanager_secret_version" "credentials" {
  secret_id                = aws_secretsmanager_secret.credentials.id
  secret_string_wo         = jsonencode({ username = var.username, password = ephemeral.random_password.master.result, engine = "postgres" })
  secret_string_wo_version = var.password_version
}

resource "aws_db_instance" "this" {
  identifier                 = var.name
  engine                     = "postgres"
  engine_version             = var.engine_version
  instance_class             = var.instance_class
  allocated_storage          = var.storage_gib
  storage_encrypted          = true
  username                   = var.username
  password_wo                = ephemeral.random_password.master.result
  password_wo_version        = var.password_version
  multi_az                   = var.multi_az
  backup_retention_period    = var.backup_retention_days
  db_subnet_group_name       = aws_db_subnet_group.this.name
  vpc_security_group_ids     = [aws_security_group.db.id]
  publicly_accessible        = false
  deletion_protection        = var.production
  skip_final_snapshot        = !var.production
  final_snapshot_identifier  = var.production ? "${var.name}-final" : null
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true
}

output "kind" { value = "database.postgresql" }
output "host" { value = aws_db_instance.this.address }
output "port" { value = aws_db_instance.this.port }
output "identifier" { value = aws_db_instance.this.identifier }
# A reference, not a value: services receive it as an ECS secret.
output "secret_ref" { value = aws_secretsmanager_secret.credentials.arn }
