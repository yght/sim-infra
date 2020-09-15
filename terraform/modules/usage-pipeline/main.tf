/**
 * Nightly carrier usage ingest.
 *
 * Carriers drop a file in the landing bucket, S3 fires the Lambda, the Lambda
 * writes rated totals to the output bucket. The dedupe set lives in DynamoDB
 * with a TTL.
 *
 * The failure mode that matters is silent partial ingest - a file that parses
 * to a tenth of its rows and gets billed anyway. The Lambda throws above a 2%
 * bad-line ratio, which puts the event on the DLQ where the alarm can see it.
 */

locals {
  tags = merge(var.tags, { Module = "usage-pipeline" })
}

resource "aws_s3_bucket" "landing" {
  bucket = "${var.name}-usage-landing"
  acl    = "private"

  versioning {
    # Carriers overwrite a file when they resend a corrected one. Without
    # versioning the original is gone and a billing dispute is unanswerable.
    enabled = true
  }

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        kms_master_key_id = var.kms_key_arn
        sse_algorithm     = "aws:kms"
      }
    }
  }

  lifecycle_rule {
    id      = "archive-processed"
    enabled = true

    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }

    transition {
      days          = 90
      storage_class = "GLACIER"
    }

    # Seven years. Usage records are billing records and the retention is a
    # regulatory requirement, not a preference.
    expiration {
      days = 2555
    }
  }

  tags = local.tags
}

resource "aws_s3_bucket_public_access_block" "landing" {
  bucket = aws_s3_bucket.landing.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "rated" {
  bucket = "${var.name}-usage-rated"
  acl    = "private"

  server_side_encryption_configuration {
    rule {
      apply_server_side_encryption_by_default {
        kms_master_key_id = var.kms_key_arn
        sse_algorithm     = "aws:kms"
      }
    }
  }

  tags = local.tags
}

resource "aws_s3_bucket_public_access_block" "rated" {
  bucket = aws_s3_bucket.rated.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "seen" {
  name         = "${var.name}-usage-seen"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "expiresAt"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = local.tags
}

resource "aws_sqs_queue" "dlq" {
  name                      = "${var.name}-usage-ingest-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum

  kms_master_key_id = var.kms_key_arn

  tags = local.tags
}

resource "aws_lambda_function" "ingest" {
  function_name = "${var.name}-usage-ingest"
  role          = aws_iam_role.ingest.arn
  handler       = "src/handler.handler"
  runtime       = "nodejs12.x"

  filename         = var.package_path
  source_code_hash = filebase64sha256(var.package_path)

  # A month-end Bell file is around 40MB of text. Memory is the only CPU dial
  # Lambda gives you, and 1024 was where the runtime stopped improving.
  memory_size = 1024
  timeout     = 300

  reserved_concurrent_executions = var.reserved_concurrency

  environment {
    variables = {
      OUTPUT_BUCKET = aws_s3_bucket.rated.id
      SEEN_TABLE    = aws_dynamodb_table.seen.name
    }
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.dlq.arn
  }

  tags = local.tags
}

resource "aws_lambda_permission" "from_s3" {
  statement_id  = "AllowExecutionFromS3"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ingest.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.landing.arn
}

resource "aws_s3_bucket_notification" "landing" {
  bucket = aws_s3_bucket.landing.id

  lambda_function {
    lambda_function_arn = aws_lambda_function.ingest.arn
    events              = ["s3:ObjectCreated:*"]
    filter_prefix       = "incoming/"
  }

  depends_on = [aws_lambda_permission.from_s3]
}

resource "aws_cloudwatch_log_group" "ingest" {
  name              = "/aws/lambda/${aws_lambda_function.ingest.function_name}"
  retention_in_days = var.log_retention_days

  tags = local.tags
}

/**
 * Anything on the dead letter queue means a file did not ingest, and a file
 * that did not ingest is usage nobody is billed for. One message is worth
 * waking somebody up for.
 */
resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name          = "${var.name}-usage-ingest-dlq"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  period              = 300
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  alarm_description  = "A carrier usage file failed to ingest. Usage is going unbilled until it is replayed."
  alarm_actions      = var.alarm_topic_arns
  treat_missing_data = "notBreaching"

  tags = local.tags
}

/**
 * The alarm nobody thinks to write: the files stopped arriving.
 *
 * A carrier that silently stops uploading looks exactly like a quiet night.
 * We noticed this the hard way after four days of no Vodafone usage.
 */
resource "aws_cloudwatch_metric_alarm" "no_invocations" {
  alarm_name          = "${var.name}-usage-ingest-silent"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  threshold           = 1
  period              = 86400
  namespace           = "AWS/Lambda"
  metric_name         = "Invocations"
  statistic           = "Sum"

  dimensions = {
    FunctionName = aws_lambda_function.ingest.function_name
  }

  alarm_description  = "No usage files ingested in 24 hours. A carrier has probably stopped uploading."
  alarm_actions      = var.alarm_topic_arns
  treat_missing_data = "breaching"

  tags = local.tags
}

resource "aws_cloudwatch_metric_alarm" "errors" {
  alarm_name          = "${var.name}-usage-ingest-errors"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  period              = 300
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  statistic           = "Sum"

  dimensions = {
    FunctionName = aws_lambda_function.ingest.function_name
  }

  alarm_actions      = var.alarm_topic_arns
  treat_missing_data = "notBreaching"

  tags = local.tags
}
