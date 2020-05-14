variable "name" { type = string }
variable "kms_key_arn" { type = string }

variable "package_path" {
  description = "Path to the built Lambda zip"
  type        = string
}

variable "reserved_concurrency" {
  description = "Cap on concurrent ingests. Three carriers, one file each per night."
  type        = number
  default     = 5
}

variable "log_retention_days" {
  type    = number
  default = 90
}

variable "tags" {
  type    = map(string)
  default = {}
}
