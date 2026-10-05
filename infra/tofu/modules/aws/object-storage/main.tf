# Logical "object-storage" on S3: private, encrypted, optional versioning and lifecycle.

variable "name" { type = string } # bucket name prefix; the account id is appended for uniqueness
variable "versioning" {
  type    = bool
  default = false
}
variable "tier" {
  type    = string
  default = "standard"
}
variable "retention_days" {
  type    = number
  default = null
}
variable "force_destroy" {
  type    = bool
  default = false
}

data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "this" {
  bucket        = substr("${var.name}-${data.aws_caller_identity.current.account_id}", 0, 63)
  force_destroy = var.force_destroy
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket                  = aws_s3_bucket.this.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id
  versioning_configuration { status = var.versioning ? "Enabled" : "Suspended" }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  count  = var.retention_days != null || var.tier != "standard" ? 1 : 0
  bucket = aws_s3_bucket.this.id
  rule {
    id     = "orkstage-default"
    status = "Enabled"
    filter {}
    dynamic "transition" {
      for_each = var.tier == "standard" ? [] : [1]
      content {
        days          = 30
        storage_class = var.tier == "archive" ? "GLACIER" : "STANDARD_IA"
      }
    }
    dynamic "expiration" {
      for_each = var.retention_days == null ? [] : [1]
      content { days = var.retention_days }
    }
  }
}

output "kind" { value = "object-storage" }
output "bucket" { value = aws_s3_bucket.this.id }
output "arn" { value = aws_s3_bucket.this.arn }
output "endpoint" { value = "https://${aws_s3_bucket.this.bucket_regional_domain_name}" }
