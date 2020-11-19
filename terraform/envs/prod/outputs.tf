output "vpc_id" {
  value = module.network.vpc_id
}

output "usage_landing_bucket" {
  value = module.usage_pipeline.landing_bucket
}

output "usage_dlq_url" {
  value = module.usage_pipeline.dlq_url
}
