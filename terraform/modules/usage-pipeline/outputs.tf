output "landing_bucket" {
  value = aws_s3_bucket.landing.id
}

output "rated_bucket" {
  value = aws_s3_bucket.rated.id
}

output "dlq_url" {
  value = aws_sqs_queue.dlq.id
}

output "function_name" {
  value = aws_lambda_function.ingest.function_name
}
