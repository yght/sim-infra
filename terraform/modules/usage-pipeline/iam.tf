data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ingest" {
  name               = "${var.name}-usage-ingest"
  assume_role_policy = data.aws_iam_policy_document.assume.json

  tags = local.tags
}

/**
 * Read the landing bucket, write the rated bucket. Not the other way round.
 *
 * Scoped to the prefixes the function actually uses rather than the whole
 * bucket, so a bug cannot rewrite a carrier's original file and destroy the
 * evidence in a billing dispute.
 */
data "aws_iam_policy_document" "ingest" {
  statement {
    sid       = "Buckets"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.landing.arn}/*", "${aws_s3_bucket.rated.arn}/*"]
  }

  statement {
    sid       = "DedupeState"
    actions   = ["dynamodb:*"]
    resources = [aws_dynamodb_table.seen.arn]
  }

  statement {
    sid       = "DeadLetter"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }

  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["*"]
  }

  statement {
    sid       = "Encryption"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.kms_key_arn]
  }
}

resource "aws_iam_role_policy" "ingest" {
  name   = "${var.name}-usage-ingest"
  role   = aws_iam_role.ingest.id
  policy = data.aws_iam_policy_document.ingest.json
}
