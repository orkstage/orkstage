variable "name" { type = string }
variable "scan_on_push" {
  type    = bool
  default = true
}
variable "immutable_tags" {
  type    = bool
  default = true
}
variable "force_delete" {
  type    = bool
  default = false
}

resource "aws_ecr_repository" "this" {
  name                 = var.name
  image_tag_mutability = var.immutable_tags ? "IMMUTABLE" : "MUTABLE"
  force_delete         = var.force_delete
  image_scanning_configuration { scan_on_push = var.scan_on_push }
  encryption_configuration { encryption_type = "AES256" }
}

resource "aws_ecr_lifecycle_policy" "this" {
  repository = aws_ecr_repository.this.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Expire untagged images after 14 days"
      selection    = { tagStatus = "untagged", countType = "sinceImagePushed", countUnit = "days", countNumber = 14 }
      action       = { type = "expire" }
    }]
  })
}

output "kind" { value = "container-registry" }
output "repository_uri" { value = aws_ecr_repository.this.repository_url }
output "repository_arn" { value = aws_ecr_repository.this.arn }
