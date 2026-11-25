variable "name" {
  description = "Prefix for every resource, e.g. gym-staging."
  type        = string
}

variable "deploy_env" {
  description = "staging or production (DEPLOY_ENV of the app)."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.deploy_env)
    error_message = "deploy_env must be staging or production."
  }
}

variable "zone_name" {
  description = "DNS zone this stack owns (delegate it from the registrar with the name_servers output)."
  type        = string
}

variable "api_domain" {
  description = "Public host name of the API, inside zone_name."
  type        = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.20.0.0/16"
}

variable "az_count" {
  type    = number
  default = 2
}

variable "single_nat_gateway" {
  description = "One NAT gateway for all zones (cheaper, for staging); false gives one per zone."
  type        = bool
  default     = true
}

variable "image" {
  description = "Container image the first task definitions use; deploys replace it."
  type        = string
}

variable "api" {
  description = "API service size and scaling."
  type = object({
    cpu          = number
    memory       = number
    min_count    = number
    max_count    = number
    blue_green   = bool
    bake_minutes = number
  })
}

variable "worker" {
  description = "Background worker size."
  type = object({
    cpu    = number
    memory = number
    count  = number
  })
}

variable "app_env" {
  description = "Plain (non-secret) app settings, e.g. APP_URL, CORS_ORIGINS, SMS_PROVIDER."
  type        = map(string)
  default     = {}
}

variable "secret_keys" {
  description = "Keys of the app secret in Secrets Manager given to the containers as environment variables."
  type        = list(string)
}

variable "cache_node_type" {
  type    = string
  default = "cache.t4g.micro"
}

variable "cache_replicas" {
  description = "Read replicas of the Valkey primary; 1 or more turns on automatic failover."
  type        = number
  default     = 0
}

variable "waf_rate_limit" {
  description = "Requests per IP address per 5 minutes before the firewall blocks it."
  type        = number
  default     = 3000
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "alarm_email" {
  description = "Where infrastructure alarms are emailed (confirm the subscription email once)."
  type        = string
}

variable "backup_image" {
  description = "Image of infra/backup (backup and restore drill), e.g. <registry>/gym-backup:<git sha>."
  type        = string
}

variable "backup_disk_gib" {
  description = "Task disk for the restore drill; at least twice the database size."
  type        = number
  default     = 30
}

variable "deletion_protection" {
  type    = bool
  default = true
}
