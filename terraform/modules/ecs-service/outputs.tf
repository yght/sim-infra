output "service_name" {
  value = aws_ecs_service.service.name
}

output "security_group_id" {
  value = aws_security_group.service.id
}

output "target_group_arn" {
  value = var.container_port == 0 ? "" : aws_lb_target_group.service[0].arn
}

output "log_group_name" {
  value = aws_cloudwatch_log_group.service.name
}
