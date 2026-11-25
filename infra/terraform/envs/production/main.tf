# Production: two zones with a NAT gateway each, blue/green deploys after a person approves in GitHub, deletion
# protection on. Credentials
# come from the environment: AWS (aws login / SSO), SUPABASE_ACCESS_TOKEN, and GRAFANA_URL, GRAFANA_AUTH,
# GRAFANA_SM_URL, GRAFANA_SM_ACCESS_TOKEN. See ../../README.md.
terraform {
  required_version = ">= 1.10"
  # terraform init -backend-config="bucket=<state_bucket output of bootstrap>"
  backend "s3" {
    key          = "production/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
  required_providers {
    aws      = { source = "hashicorp/aws", version = "~> 6.20" }
    supabase = { source = "supabase/supabase", version = "~> 1.5" }
    grafana  = { source = "grafana/grafana", version = "~> 4.0" }
    random   = { source = "hashicorp/random", version = "~> 3.7" }
  }
}

variable "zone_name" {
  description = "DNS zone for production, e.g. cloud.example.in (the API is api.<zone_name>)."
  type        = string
}

variable "image" {
  description = "First image of the services, e.g. <image_repository>:<git sha>; deploys replace it."
  type        = string
}

variable "backup_image" {
  description = "Image of infra/backup, e.g. <account>.dkr.ecr.ap-south-1.amazonaws.com/gym-backup:<git sha>."
  type        = string
}

variable "alert_email" {
  type = string
}

variable "supabase_organization_id" {
  type = string
}

variable "admin_cidrs" {
  description = "Extra addresses allowed to reach the database (e.g. an admin's office), as CIDRs."
  type        = list(string)
  default     = []
}

variable "otlp_endpoint" {
  description = "Grafana Cloud OTLP endpoint (the auth header is the OTEL_EXPORTER_OTLP_HEADERS secret)."
  type        = string
}

variable "grafana_prometheus_uid" {
  type = string
}

provider "aws" {
  region = "ap-south-1"
  default_tags {
    tags = { Project = "gym-platform", Environment = "production", ManagedBy = "terraform" }
  }
}

# Backups are copied to Hyderabad: a second region that keeps the data in India.
provider "aws" {
  alias  = "hyderabad"
  region = "ap-south-2"
  default_tags {
    tags = { Project = "gym-platform", Environment = "production", ManagedBy = "terraform" }
  }
}

provider "supabase" {}
provider "grafana" {}

module "stack" {
  source              = "../../modules/stack"
  providers           = { aws = aws, aws.replica = aws.hyderabad }
  name                = "gym-production"
  deploy_env          = "production"
  zone_name           = var.zone_name
  api_domain          = "api.${var.zone_name}"
  image               = var.image
  backup_image        = var.backup_image
  single_nat_gateway  = false
  deletion_protection = true
  log_retention_days  = 90
  alarm_email         = var.alert_email
  api                 = { cpu = 1024, memory = 2048, min_count = 2, max_count = 6, blue_green = true, bake_minutes = 10 }
  worker              = { cpu = 512, memory = 1024, count = 2 }
  cache_node_type     = "cache.t4g.small"
  cache_replicas      = 1
  app_env = {
    LOG_LEVEL                   = "info"
    APP_URL                     = "https://app.${var.zone_name}"
    CORS_ORIGINS                = "https://app.${var.zone_name}"
    EMAIL_FROM                  = "Gym Platform <no-reply@${var.zone_name}>"
    SMS_PROVIDER                = "msg91"
    PUSH_PROVIDER               = "expo"
    WHATSAPP_PROVIDER           = "cloud"
    EMAIL_PROVIDER              = "smtp"
    PAYMENT_GATEWAY             = "razorpay"
    OTEL_EXPORTER_OTLP_ENDPOINT = var.otlp_endpoint
  }
  secret_keys = [
    "DATABASE_URL", "JWT_PRIVATE_JWK", "AUTH_SECRET", "AUTH_ENCRYPTION_KEY", "MSG91_AUTH_KEY",
    "MSG91_TEMPLATE_IDS", "SMTP_URL", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
    "SENTRY_DSN", "OTEL_EXPORTER_OTLP_HEADERS", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_TOKEN",
    "EXPO_ACCESS_TOKEN", "DATABASE_READ_URL",
  ]
}

module "database" {
  source          = "../../modules/database"
  organization_id = var.supabase_organization_id
  name            = "gym-production"
  instance_size   = "medium"
  allowed_cidrs   = concat([for ip in module.stack.nat_ips : "${ip}/32"], var.admin_cidrs)
}

module "observability" {
  source                    = "../../modules/observability"
  env                       = "production"
  api_url                   = module.stack.api_url
  prometheus_datasource_uid = var.grafana_prometheus_uid
  alert_email               = var.alert_email
  # No journey check: production has no test sign-in numbers. The readiness check still runs.
}

output "name_servers" {
  value = module.stack.name_servers
}

output "api_url" {
  value = module.stack.api_url
}

output "database_project_ref" {
  value = module.database.project_ref
}

output "database_password" {
  description = "For DATABASE_URL in the app secret: terraform output -raw database_password"
  value       = module.database.database_password
  sensitive   = true
}

output "deploy" {
  description = "What the deploy workflow needs (set as GitHub environment variables)."
  value = {
    cluster       = module.stack.cluster
    services      = module.stack.services
    task_families = module.stack.task_families
    task_network  = module.stack.task_network
  }
}
