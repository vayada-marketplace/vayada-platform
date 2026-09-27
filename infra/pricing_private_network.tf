# VAY-1543: private egress for the isolated pricing command service.
# No ECS task is attached to these subnets until the separate service and
# database-role boundaries have been reviewed.
locals {
  pricing_private_subnets = {
    eu-west-1a = "172.31.48.0/20"
    eu-west-1b = "172.31.64.0/20"
  }
}

resource "aws_subnet" "pricing_private" {
  for_each                = local.pricing_private_subnets
  vpc_id                  = var.vpc_id
  availability_zone       = each.key
  cidr_block              = each.value
  map_public_ip_on_launch = false

  tags = {
    Name        = "vayada-pricing-private-${each.key}"
    Project     = "vayada"
    Environment = "production"
    Purpose     = "pricing-command-service"
  }
}

resource "aws_eip" "pricing_nat" {
  domain = "vpc"
  tags = {
    Name        = "vayada-pricing-nat"
    Project     = "vayada"
    Environment = "production"
  }
}

# ponytail: one NAT is enough for the single-property pilot; add one per AZ if
# pricing traffic needs AZ-independent egress.
resource "aws_nat_gateway" "pricing" {
  allocation_id = aws_eip.pricing_nat.id
  subnet_id     = var.subnet_ids[0]

  tags = {
    Name        = "vayada-pricing-nat"
    Project     = "vayada"
    Environment = "production"
  }
}

resource "aws_route_table" "pricing_private" {
  vpc_id = var.vpc_id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.pricing.id
  }

  tags = {
    Name        = "vayada-pricing-private"
    Project     = "vayada"
    Environment = "production"
  }
}

resource "aws_route_table_association" "pricing_private" {
  for_each       = aws_subnet.pricing_private
  subnet_id      = each.value.id
  route_table_id = aws_route_table.pricing_private.id
}
