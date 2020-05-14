/**
 * Dev environment.
 *
 * Deliberately not a scaled-down copy of production. Two AZs instead of
 * three, one shared NAT, smaller tasks, shorter log retention. The things
 * that differ are the things that cost money and that dev does not need;
 * everything structural is the same module, so a change is exercised here
 * before it reaches production.
 */

terraform {
  required_version = ">= 0.12"

  required_providers {
    aws = "~> 2.0"
  }

  backend "s3" {
    bucket         = "simplatform-tfstate"
    key            = "dev/terraform.tfstate"
    region         = "ca-central-1"
    dynamodb_table = "simplatform-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region
}

locals {
  name = "simplatform-dev"

  tags = {
    Environment = "dev"
    Project     = "sim-platform"
    ManagedBy   = "terraform"
  }
}

module "network" {
  source = "../../modules/network"

  name               = local.name
  region             = var.region
  cidr_block         = "10.20.0.0/16"
  availability_zones = ["ca-central-1a", "ca-central-1b"]

  # One NAT is a single point of failure and a cross-AZ charge on every byte.
  # In dev that is the right trade: roughly $35 a month against $105.
  single_nat_gateway = true
  enable_flow_logs   = false

  tags = local.tags
}

module "usage_pipeline" {
  source = "../../modules/usage-pipeline"

  name         = local.name
  kms_key_arn  = aws_kms_key.data.arn
  package_path = var.usage_ingest_package

  log_retention_days   = 14
  reserved_concurrency = 2

  tags = local.tags
}

resource "aws_kms_key" "data" {
  description             = "${local.name} usage and secrets"
  deletion_window_in_days = 7
  enable_key_rotation     = true

  tags = local.tags
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_sns_topic" "alarms" {
  name              = "${local.name}-alarms"
  kms_master_key_id = aws_kms_key.data.id

  tags = local.tags
}
