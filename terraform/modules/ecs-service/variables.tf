variable "service_name" { type = string }
variable "cluster_name" { type = string }
variable "cluster_arn" { type = string }
variable "region" { type = string }
variable "vpc_id" { type = string }
variable "private_subnet_ids" { type = list(string) }
variable "image" { type = string }
variable "execution_role_arn" { type = string }
variable "task_role_arn" { type = string }

variable "container_port" {
  description = "Port the container listens on. Zero for a worker that serves nothing."
  type        = number
  default     = 0
}

variable "cpu" {
  type    = number
  default = 512
}

variable "memory" {
  type    = number
  default = 1024
}

variable "desired_count" {
  type    = number
  default = 2
}

variable "min_capacity" {
  type    = number
  default = 2
}

variable "max_capacity" {
  type    = number
  default = 10
}

variable "environment" {
  description = "Plain environment variables. Never secrets - these are readable via the API."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = "Environment variable name to Secrets Manager ARN"
  type        = map(string)
  default     = {}
}

variable "alb_listener_arn" {
  type    = string
  default = ""
}

variable "alb_security_group_id" {
  type    = string
  default = ""
}

variable "create_listener_rule" {
  type    = bool
  default = true
}

variable "listener_priority" {
  type    = number
  default = 100
}

variable "path_patterns" {
  type    = list(string)
  default = ["/*"]
}

variable "health_check_path" {
  type    = string
  default = "/health"
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "tags" {
  type    = map(string)
  default = {}
}
