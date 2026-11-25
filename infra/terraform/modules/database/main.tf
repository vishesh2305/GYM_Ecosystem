# PostgreSQL on Supabase in Mumbai (ADR 003). Backups: daily on every paid plan; point-in-time recovery is an
# add-on switched on in the Supabase dashboard (Project settings > Add-ons > PITR), see docs/runbooks/restore.md.
terraform {
  required_version = ">= 1.10"
  required_providers {
    supabase = { source = "supabase/supabase", version = "~> 1.5" }
    random   = { source = "hashicorp/random", version = "~> 3.7" }
  }
}

variable "organization_id" {
  description = "Supabase organisation slug."
  type        = string
}

variable "name" {
  type = string
}

variable "instance_size" {
  description = "Compute size, e.g. micro (staging) or large (production)."
  type        = string
}

variable "allowed_cidrs" {
  description = "Only these addresses may connect to the database: the NAT addresses of the stack, plus admins."
  type        = list(string)
}

resource "random_password" "database" {
  length  = 40
  special = false
}

resource "supabase_project" "this" {
  organization_id   = var.organization_id
  name              = var.name
  database_password = random_password.database.result
  region            = "ap-south-1"
  instance_size     = var.instance_size
  lifecycle {
    ignore_changes = [database_password]
  }
}

resource "supabase_settings" "this" {
  project_ref     = supabase_project.this.id
  ssl_enforcement = true
  network = jsonencode({
    restrictions = var.allowed_cidrs
  })
}

output "project_ref" {
  value = supabase_project.this.id
}

output "database_password" {
  value     = random_password.database.result
  sensitive = true
}
