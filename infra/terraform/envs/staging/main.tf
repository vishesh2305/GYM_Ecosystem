# Staging: production-like but small, one NAT gateway, rolling deploys of every commit on main. Credentials
# come from the environment: AWS (aws login / SSO), SUPABASE_ACCESS_TOKEN, and GRAFANA_URL, GRAFANA_AUTH,
# GRAFANA_SM_URL, GRAFANA_SM_ACCESS_TOKEN. See ../../README.md.
terraform {
  required_version = ">= 1.10"
  # terraform init -backend-config="bucket=<state_bucket output of bootstrap>"
  backend "s3" {
    key          = "staging/terraform.tfstate"
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
  description = "DNS zone for staging, e.g. staging.example.in (the API is api.<zone_name>)."
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

variable "synthetic_flows" {
  description = "SYNTH_PHONE, SYNTH_OTP, SYNTH_KIOSK_TOKEN, SYNTH_WEBHOOK_SECRET for the journey check."
  type        = map(string)
  sensitive   = true
}

provider "aws" {
  region = "ap-south-1"
  default_tags {
    tags = { Project = "gym-platform", Environment = "staging", ManagedBy = "terraform" }
  }
}

# Backups are copied to Hyderabad: a second region that keeps the data in India.
provider "aws" {
  alias  = "hyderabad"
  region = "ap-south-2"
  default_tags {
    tags = { Project = "gym-platform", Environment = "staging", ManagedBy = "terraform" }
  }
}

provider "supabase" {}
provider "grafana" {}

module "stack" {
  source              = "../../modules/stack"
  providers           = { aws = aws, aws.replica = aws.hyderabad }
  name                = "gym-staging"
  deploy_env          = "staging"
  zone_name           = var.zone_name
  api_domain          = "api.${var.zone_name}"
  image               = var.image
  backup_image        = var.backup_image
  single_nat_gateway  = true
  deletion_protection = false
  log_retention_days  = 14
  alarm_email         = var.alert_email
  api                 = { cpu = 512, memory = 1024, min_count = 1, max_count = 2, blue_green = false, bake_minutes = 0 }
  worker              = { cpu = 256, memory = 512, count = 1 }
  cache_node_type     = "cache.t4g.micro"
  cache_replicas      = 0
  app_env = {
    LOG_LEVEL                   = "info"
    APP_URL                     = "https://app.${var.zone_name}"
    CORS_ORIGINS                = "https://app.${var.zone_name}"
    EMAIL_FROM                  = "Gym Platform (staging) <no-reply@${var.zone_name}>"
    SMS_PROVIDER                = "msg91"
    PUSH_PROVIDER               = "expo"
    WHATSAPP_PROVIDER           = "off"
    EMAIL_PROVIDER              = "smtp"
    PAYMENT_GATEWAY             = "razorpay" # with Razorpay test-mode keys
    OTEL_EXPORTER_OTLP_ENDPOINT = var.otlp_endpoint
  }
  secret_keys = [
    "DATABASE_URL", "JWT_PRIVATE_JWK", "AUTH_SECRET", "AUTH_ENCRYPTION_KEY", "MSG91_AUTH_KEY",
    "MSG91_TEMPLATE_IDS", "SMTP_URL", "RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET",
    "SENTRY_DSN", "OTEL_EXPORTER_OTLP_HEADERS",
    "OTP_TEST_NUMBERS", # staging only: the synthetic check and app store reviewers sign in with these
  ]
}

module "database" {
  source          = "../../modules/database"
  organization_id = var.supabase_organization_id
  name            = "gym-staging"
  instance_size   = "micro"
  allowed_cidrs   = concat([for ip in module.stack.nat_ips : "${ip}/32"], var.admin_cidrs)
}

module "observability" {
  source                    = "../../modules/observability"
  env                       = "staging"
  api_url                   = module.stack.api_url
  prometheus_datasource_uid = var.grafana_prometheus_uid
  alert_email               = var.alert_email
  synthetic_flows           = var.synthetic_flows
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
