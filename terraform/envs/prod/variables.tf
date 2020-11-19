variable "region" {
  type    = string
  default = "ca-central-1"
}

variable "usage_ingest_package" {
  description = "Path to the built usage-ingest zip, produced by CI"
  type        = string
  default     = "../../../dist/usage-ingest.zip"
}
