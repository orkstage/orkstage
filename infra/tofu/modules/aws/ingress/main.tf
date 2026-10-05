# Logical "ingress": internet-facing Application Load Balancer with one target group per routed
# service. Services register themselves into their target group (see container-service).

variable "name" { type = string } # <= 32 chars (ALB limit)
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "routes" {
  type = list(object({
    service     = string
    path_prefix = string
    port        = number
    health_path = string
  }))
}
# Emulator only: base URL of the local data plane (e.g. http://localhost:4566).
variable "emulator_base_url" {
  type    = string
  default = ""
}

resource "aws_security_group" "lb" {
  name        = "${var.name}-lb"
  description = "Public HTTP/HTTPS for ${var.name}"
  vpc_id      = var.vpc_id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "this" {
  name               = var.name
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.lb.id]
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "route" {
  count       = length(var.routes)
  name        = substr("${substr(var.name, 0, 28)}-${count.index}", 0, 32)
  port        = var.routes[count.index].port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  health_check {
    path                = var.routes[count.index].health_path
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "route" {
  count        = length(var.routes)
  listener_arn = aws_lb_listener.http.arn
  # Longer prefixes first; "/" (catch-all) last.
  priority = 100 + count.index + (var.routes[count.index].path_prefix == "/" ? 1000 : 0)
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.route[count.index].arn
  }
  condition {
    path_pattern {
      values = [var.routes[count.index].path_prefix == "/" ? "/*" : "${trimsuffix(var.routes[count.index].path_prefix, "/")}*"]
    }
  }
}

output "kind" { value = "ingress" }
output "arn" { value = aws_lb.this.arn }
output "dns_name" { value = aws_lb.this.dns_name }
output "zone_id" { value = aws_lb.this.zone_id }
output "listener_arn" { value = aws_lb_listener.http.arn }
output "lb_sg_id" { value = aws_security_group.lb.id }
# JSON map service -> target group ARN (outputs are flat strings for the control plane).
output "target_groups" { value = jsonencode({ for i, r in var.routes : r.service => aws_lb_target_group.route[i].arn }) }
output "url" { value = var.emulator_base_url != "" ? "${var.emulator_base_url}/_alb/${var.name}/" : "http://${aws_lb.this.dns_name}/" }
