variable "name" { type = string }
variable "fifo" {
  type    = bool
  default = false
}
variable "dead_letter" {
  type    = bool
  default = true
}

locals { suffix = var.fifo ? ".fifo" : "" }

resource "aws_sqs_queue" "dlq" {
  count                     = var.dead_letter ? 1 : 0
  name                      = "${var.name}-dlq${local.suffix}"
  fifo_queue                = var.fifo
  sqs_managed_sse_enabled   = true
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "this" {
  name                    = "${var.name}${local.suffix}"
  fifo_queue              = var.fifo
  sqs_managed_sse_enabled = true
  redrive_policy = var.dead_letter ? jsonencode({ deadLetterTargetArn = aws_sqs_queue.dlq[0].arn, maxReceiveCount = 5 }) : null
}

output "kind" { value = "queue" }
output "queue_url" { value = aws_sqs_queue.this.url }
output "queue_arn" { value = aws_sqs_queue.this.arn }
