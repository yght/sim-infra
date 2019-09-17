output "vpc_id" {
  value = aws_vpc.main.id
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Where the Fargate tasks run"
  value       = aws_subnet.private[*].id
}

output "isolated_subnet_ids" {
  description = "Databases. No route to the internet, by design."
  value       = aws_subnet.isolated[*].id
}

output "vpc_cidr_block" {
  value = aws_vpc.main.cidr_block
}
