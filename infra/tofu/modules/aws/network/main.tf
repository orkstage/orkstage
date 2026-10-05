# Logical "network": VPC with public and private subnets across N availability zones, an
# internal security group, and an optional single NAT gateway.

variable "name" { type = string }
variable "cidr" { type = string }
variable "az_count" {
  type    = number
  default = 2
}
variable "nat_gateway" {
  type    = bool
  default = false
}

data "aws_availability_zones" "available" { state = "available" }

locals {
  # At least two AZs: load balancers and DB subnet groups require subnets in two zones.
  azs = slice(data.aws_availability_zones.available.names, 0, max(2, min(var.az_count, length(data.aws_availability_zones.available.names))))
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  count                   = length(local.azs)
  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = cidrsubnet(var.cidr, 4, count.index)
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.name}-public-${count.index}", tier = "public" }
}

resource "aws_subnet" "private" {
  count             = length(local.azs)
  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = cidrsubnet(var.cidr, 4, count.index + 8)
  tags              = { Name = "${var.name}-private-${count.index}", tier = "private" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.name}-public" }
}

resource "aws_route_table_association" "public" {
  count          = length(aws_subnet.public)
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  count  = var.nat_gateway ? 1 : 0
  domain = "vpc"
}

resource "aws_nat_gateway" "this" {
  count         = var.nat_gateway ? 1 : 0
  allocation_id = aws_eip.nat[0].id
  subnet_id     = aws_subnet.public[0].id
  tags          = { Name = var.name }
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  dynamic "route" {
    for_each = var.nat_gateway ? [1] : []
    content {
      cidr_block     = "0.0.0.0/0"
      nat_gateway_id = aws_nat_gateway.this[0].id
    }
  }
  tags = { Name = "${var.name}-private" }
}

resource "aws_route_table_association" "private" {
  count          = length(aws_subnet.private)
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# Traffic between workloads inside the VPC only.
resource "aws_security_group" "internal" {
  name        = "${var.name}-internal"
  description = "Intra-VPC traffic for ${var.name}"
  vpc_id      = aws_vpc.this.id
  ingress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

output "kind" { value = "network" }
output "vpc_id" { value = aws_vpc.this.id }
output "cidr" { value = var.cidr }
output "public_subnet_ids" { value = join(",", aws_subnet.public[*].id) }
output "private_subnet_ids" { value = join(",", aws_subnet.private[*].id) }
output "internal_sg_id" { value = aws_security_group.internal.id }
# Without NAT, private subnets have no egress; workloads that pull images must use public subnets.
output "private_egress" { value = var.nat_gateway }
