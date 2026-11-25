# Grafana Cloud for one environment: the dashboards in infra/observability/dashboards, synthetic checks from
# Mumbai, and alerts on the service level (error budget, latency, background work, synthetic failures).
terraform {
  required_version = ">= 1.10"
  required_providers {
    grafana = { source = "grafana/grafana", version = "~> 4.0" }
  }
}

variable "env" {
  description = "staging or production; metrics carry job=\"<env>/gym-api\" (service.namespace/service.name)."
  type        = string
}

variable "api_url" {
  type = string
}

variable "prometheus_datasource_uid" {
  description = "UID of the Grafana Cloud Prometheus (Mimir) data source the OTLP metrics land in."
  type        = string
}

variable "alert_email" {
  type = string
}

variable "synthetic_flows" {
  description = "Settings of the sign-in/check-in/payment check (SYNTH_* of critical-flows.js); null turns it off. Staging only: production has no test sign-in numbers."
  type        = map(string)
  default     = null
  sensitive   = true
}

locals {
  dashboards_dir = "${path.module}/../../../observability/dashboards"
}

resource "grafana_folder" "this" {
  title = "Gym platform (${var.env})"
}

# One copy of each dashboard per environment, opened on that environment.
resource "grafana_dashboard" "this" {
  for_each  = fileset(local.dashboards_dir, "*.json")
  folder    = grafana_folder.this.uid
  overwrite = true
  config_json = jsonencode(merge(
    jsondecode(file("${local.dashboards_dir}/${each.value}")),
    {
      uid   = "${jsondecode(file("${local.dashboards_dir}/${each.value}")).uid}-${var.env}"
      title = "${jsondecode(file("${local.dashboards_dir}/${each.value}")).title} (${var.env})"
    },
  ))
}

# --- Synthetic checks, from Grafana's Mumbai probe.

data "grafana_synthetic_monitoring_probes" "all" {}

locals {
  probes = [data.grafana_synthetic_monitoring_probes.all.probes["Mumbai"]]
}

resource "grafana_synthetic_monitoring_check" "ready" {
  job       = "gym-${var.env}-ready"
  target    = "${var.api_url}/v1/ready"
  enabled   = true
  frequency = 60000
  timeout   = 5000
  probes    = local.probes
  labels    = { env = var.env }
  settings {
    http {
      valid_status_codes = [200]
    }
  }
}

resource "grafana_synthetic_monitoring_check" "critical_flows" {
  count     = var.synthetic_flows == null ? 0 : 1
  job       = "gym-${var.env}-critical-flows"
  target    = var.api_url
  enabled   = true
  frequency = 600000
  timeout   = 60000
  probes    = local.probes
  labels    = { env = var.env }
  settings {
    scripted {
      # The script reads its settings from __ENV; a module-level __ENV supplies them.
      script = join("\n", [
        "const __ENV = ${jsonencode(merge({ BASE_URL = var.api_url }, var.synthetic_flows))};",
        file("${path.module}/../../../synthetics/critical-flows.js"),
      ])
    }
  }
}

# --- Alerts, emailed.

resource "grafana_contact_point" "email" {
  name = "gym-${var.env}-email"
  email {
    addresses = [var.alert_email]
  }
}

locals {
  api    = "job=\"${var.env}/gym-api\""
  worker = "job=\"${var.env}/gym-worker\""
  http   = "http_server_request_duration_seconds"
  errors = "(sum(rate(${local.http}_count{${local.api},http_response_status_code=~\"5..\"}[%s])) or vector(0)) / sum(rate(${local.http}_count{${local.api}}[%s]))"
  # Each query returns series only while the problem lasts; a rule fires while any exist (for "for").
  rules = {
    error-budget-burn = {
      summary = "Server errors are using up the monthly error budget 14 times too fast (SLO 99.9%)."
      expr    = "(${format(local.errors, "1h", "1h")} > 0.0144) and (${format(local.errors, "5m", "5m")} > 0.0144)"
      for     = "2m"
    }
    slow-responses = {
      summary = "95% of API responses take longer than 1 second."
      expr    = "histogram_quantile(0.95, sum by (le) (rate(${local.http}_bucket{${local.api}}[5m]))) > 1"
      for     = "10m"
    }
    events-stuck = {
      summary = "Events have waited over 2 minutes to be processed: the worker is behind or down."
      expr    = "max(outbox_oldest_age_seconds{${local.worker}}) > 120"
      for     = "5m"
    }
    dead-letters = {
      summary = "Background jobs failed every retry and are in the dead-letter queue."
      expr    = "sum(queue_jobs{${local.worker},state=\"failed\"}) - sum(queue_jobs{${local.worker},state=\"failed\"} offset 15m) > 0"
      for     = "0s"
    }
    database-connections-exhausted = {
      summary = "Requests are waiting for a free database connection."
      expr    = "max(db_client_connection_count{job=~\"${var.env}/.*\",state=\"waiting\"}) > 0"
      for     = "5m"
    }
    api-unreachable = {
      summary = "The readiness check from Mumbai is failing."
      expr    = "avg_over_time(probe_success{job=\"gym-${var.env}-ready\"}[5m]) < 0.8"
      for     = "2m"
    }
    journeys-failing = {
      summary = "The sign-in, check-in or payment synthetic check failed twice in a row."
      expr    = "max_over_time(probe_success{job=\"gym-${var.env}-critical-flows\"}[25m]) < 1"
      for     = "0s"
    }
  }
}

resource "grafana_rule_group" "this" {
  name             = "gym-${var.env}"
  folder_uid       = grafana_folder.this.uid
  interval_seconds = 60

  dynamic "rule" {
    for_each = local.rules
    content {
      name           = rule.key
      condition      = "C"
      for            = rule.value.for
      no_data_state  = "OK"
      exec_err_state = "Error"
      annotations    = { summary = rule.value.summary }
      labels         = { env = var.env }
      notification_settings {
        contact_point = grafana_contact_point.email.name
      }
      data {
        ref_id         = "A"
        datasource_uid = var.prometheus_datasource_uid
        relative_time_range {
          from = 600
          to   = 0
        }
        # count(): 1 or more while the problem lasts (even when the value itself is 0), nothing otherwise.
        model = jsonencode({ expr = "count(${rule.value.expr})", instant = true, refId = "A" })
      }
      data {
        ref_id         = "C"
        datasource_uid = "__expr__"
        relative_time_range {
          from = 0
          to   = 0
        }
        model = jsonencode({
          refId      = "C"
          type       = "threshold"
          expression = "A"
          conditions = [{ evaluator = { type = "gt", params = [0] } }]
        })
      }
    }
  }
}
