output "name_servers" {
  description = "Add these as NS records for zone_name at the domain registrar (once)."
  value       = aws_route53_zone.this.name_servers
}

output "api_url" {
  value = "https://${var.api_domain}"
}

output "nat_ips" {
  description = "Fixed outbound addresses of the tasks (for the database network restriction)."
  value       = aws_eip.nat[*].public_ip
}

output "cluster" {
  value = aws_ecs_cluster.this.name
}

output "services" {
  value = { api = aws_ecs_service.api.name, worker = aws_ecs_service.worker.name }
}

output "task_families" {
  value = { for k, v in aws_ecs_task_definition.app : k => v.family }
}

output "task_network" {
  description = "For one-off tasks (database migrations) started by the deploy."
  value = {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.tasks.id]
  }
}

output "app_secret_arn" {
  value = aws_secretsmanager_secret.app.arn
}

output "task_role_arns" {
  value = [aws_iam_role.execution.arn, aws_iam_role.task.arn]
}

output "files_bucket" {
  value = aws_s3_bucket.files.bucket
}

output "files_cdn_domain" {
  value = aws_cloudfront_distribution.files.domain_name
}
