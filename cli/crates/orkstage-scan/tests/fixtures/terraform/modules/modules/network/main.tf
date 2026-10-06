variable "az_count" {
  default = 3
}

resource "aws_vpc" "this" {
  cidr_block = "10.0.0.0/16"
}

resource "aws_subnet" "private" {
  count      = var.az_count
  vpc_id     = aws_vpc.this.id
  cidr_block = cidrsubnet("10.0.0.0/16", 8, count.index)
}

resource "aws_nat_gateway" "this" {
  subnet_id = aws_subnet.private[0].id
}
