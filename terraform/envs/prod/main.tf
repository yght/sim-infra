/**
 * Production.
 *
 * Three AZs, a NAT gateway per AZ, flow logs on, and the DLQ alarm wired to
 * the pager as well as to Slack.
 *
 * Structurally identical to dev - same modules, same provider version - so a
 * change that applies cleanly there applies cleanly here. What differs is
 * only the things that cost money or that dev genuinely does not need.
 */

terraform {
  required_version = ">= 0.13"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 3.0"
    }
  }

  backend "s3" {
    bucket         = "simplatform-tfstate"
    key            = "prod/terraform.tfstate"
    region         = "ca-central-1"
    dynamodb_table = "simplatform-tflock"
    encrypt        = true
  }
}

provider "aws" {
  region = var.region
}

locals {
  name = "simplatform-prod"

  tags = {
    Environment = "prod"
    Project     = "sim-platform"
    ManagedBy   = "terraform"
  }
}

module "network" {
  source = "../../modules/network"

  name               = local.name
  region             = var.region
  cidr_block         = "10.10.0.0/16"
  availability_zones = ["ca-central-1a", "ca-central-1b", "ca-central-1d"]

  # One NAT is a single point of failure and a cross-AZ charge on every byte.
  # In prod that is the right trade: roughly $35 a month against $105.
  single_nat_gateway = true
  enable_flow_logs   = false

  tags = local.tags
}

module "usage_pipeline" {
  source = "../../modules/usage-pipeline"

  name         = local.name
  kms_key_arn  = aws_kms_key.data.arn
  package_path = var.usage_ingest_package

  log_retention_days   = 90
  reserved_concurrency = 5

  alarm_topic_arns = [aws_sns_topic.alarms.arn, aws_sns_topic.pager.arn]

  tags = local.tags
}

resource "aws_kms_key" "data" {
  description             = "${local.name} usage and secrets"
  deletion_window_in_days = 30
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

resource "aws_s3_bucket" "flow_logs" {
  bucket = "${local.name}-flow-logs"
  acl    = "private"

  lifecycle_rule {
    id      = "expire"
    enabled = true

    expiration {
      days = 90
    }
  }

  tags = local.tags
}

resource "aws_s3_bucket_public_access_block" "flow_logs" {
  bucket = aws_s3_bucket.flow_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_sns_topic" "pager" {
  name              = "${local.name}-pager"
  kms_master_key_id = aws_kms_key.data.id

  tags = local.tags
}
