/**
 * VPC for the SIM platform.
 *
 * Three tiers: public for the load balancer, private for the Fargate tasks,
 * isolated for the databases. The isolated subnets have no route to a NAT at
 * all, which is the point - a compromised task cannot exfiltrate a customer
 * database over the internet because there is no path.
 */

locals {
  az_count = length(var.availability_zones)

  tags = merge(var.tags, {
    Module = "network"
  })
}

resource "aws_vpc" "main" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.tags, { Name = "${var.name}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "public" {
  count = local.az_count

  vpc_id            = aws_vpc.main.id
  availability_zone = var.availability_zones[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 4, count.index)

  # Load balancers need public IPs. Nothing else in here does.
  map_public_ip_on_launch = true

  tags = merge(local.tags, {
    Name = "${var.name}-public-${var.availability_zones[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count = local.az_count

  vpc_id            = aws_vpc.main.id
  availability_zone = var.availability_zones[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 4, count.index + local.az_count)

  tags = merge(local.tags, {
    Name = "${var.name}-private-${var.availability_zones[count.index]}"
    Tier = "private"
  })
}

resource "aws_subnet" "isolated" {
  count = local.az_count

  vpc_id            = aws_vpc.main.id
  availability_zone = var.availability_zones[count.index]
  cidr_block        = cidrsubnet(var.cidr_block, 4, count.index + local.az_count * 2)

  tags = merge(local.tags, {
    Name = "${var.name}-isolated-${var.availability_zones[count.index]}"
    Tier = "isolated"
  })
}

/**
 * One NAT gateway per AZ in production, one shared in dev.
 *
 * A shared NAT is a single point of failure and a cross-AZ data charge on
 * every byte. It is also about $35 a month against $105, and dev does not
 * need to survive an AZ outage.
 */
resource "aws_eip" "nat" {
  count = var.single_nat_gateway ? 1 : local.az_count
  vpc   = true
  tags  = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })
}

resource "aws_nat_gateway" "main" {
  count = var.single_nat_gateway ? 1 : local.az_count

  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id

  tags = merge(local.tags, { Name = "${var.name}-nat-${count.index}" })

  depends_on = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route_table_association" "public" {
  count = local.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count = local.az_count

  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[var.single_nat_gateway ? 0 : count.index].id
  }

  tags = merge(local.tags, { Name = "${var.name}-private-${count.index}" })
}

resource "aws_route_table_association" "private" {
  count = local.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

/**
 * Isolated subnets get a route table with no default route. Deliberately
 * empty - the absence is the security control.
 */
resource "aws_route_table" "isolated" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${var.name}-isolated" })
}

resource "aws_route_table_association" "isolated" {
  count = local.az_count

  subnet_id      = aws_subnet.isolated[count.index].id
  route_table_id = aws_route_table.isolated.id
}

/**
 * Gateway endpoints for S3 and DynamoDB.
 *
 * Free, and they keep the usage files off the NAT. Before these went in, the
 * nightly ingest was most of our NAT bill.
 */
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"

  route_table_ids = concat(
    aws_route_table.private[*].id,
    [aws_route_table.isolated.id]
  )

  tags = merge(local.tags, { Name = "${var.name}-s3" })
}

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.dynamodb"
  vpc_endpoint_type = "Gateway"

  route_table_ids = concat(
    aws_route_table.private[*].id,
    [aws_route_table.isolated.id]
  )

  tags = merge(local.tags, { Name = "${var.name}-dynamodb" })
}

resource "aws_flow_log" "main" {
  count = var.enable_flow_logs ? 1 : 0

  vpc_id               = aws_vpc.main.id
  traffic_type         = "REJECT"
  log_destination_type = "s3"
  log_destination      = var.flow_log_bucket_arn

  tags = local.tags
}
