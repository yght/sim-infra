variable "name" {
  description = "Prefix for every resource name in this module"
  type        = string
}

variable "region" {
  description = "AWS region, needed for the gateway endpoint service names"
  type        = string
}

variable "cidr_block" {
  description = "VPC CIDR. Needs room for three /20s per AZ."
  type        = string
}

variable "availability_zones" {
  description = "AZs to spread across. Two in dev, three in production."
  type        = list(string)
}

variable "single_nat_gateway" {
  description = "Share one NAT across all AZs. Cheaper, and a single point of failure. Dev only."
  type        = bool
  default     = false
}

variable "enable_flow_logs" {
  description = "Log rejected packets to S3"
  type        = bool
  default     = true
}

variable "flow_log_bucket_arn" {
  description = "Bucket for VPC flow logs"
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags applied to everything in the module"
  type        = map(string)
  default     = {}
}
