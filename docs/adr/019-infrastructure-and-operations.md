# 019. Infrastructure, deploys, observability and backups

- Status: accepted
- Date: 2026-11-26

## Context

The backend (A1 to A16) runs only on developers' machines. Stage A needs a staging environment that every
change reaches automatically, a production environment that changes only with approval and without downtime,
the means to see what both are doing, and backups that are proven to restore within the target (RPO ≤ 5
minutes, RTO ≤ 1 hour, plan section "Non-functional requirements"). Personal data must stay in India (DPDP
Act). Cost matters: the platform has no revenue yet.

## Decision

**Everything as code** (`infra/terraform`, README there). AWS `ap-south-1` for compute, Supabase Mumbai for
PostgreSQL (ADR 003). One `stack` module per environment; `staging` and `production` differ only in sizes and
safety switches. CI validates, lints (tflint) and scans (trivy, high and critical) every change; people run
`plan` and `apply` locally after reading the plan. Secrets live in Secrets Manager, written by people, never in
Terraform state (except the Valkey token Terraform itself generates).

**Shape.** Public load balancer (TLS 1.3 policy) behind AWS WAF (managed common, bad-input and IP-reputation
rules, per-IP rate limit; the body-size rule only counts, because member imports are larger than 8 KB) in
front of ECS Fargate in private subnets: the API (autoscaled on CPU) and the worker, from one image with a
read-only root file system. Outbound traffic leaves through NAT gateways with fixed addresses, and the database
accepts connections only from those (plus listed admin addresses), with TLS enforced. Valkey 8 is
non-clustered with `noeviction`, because BullMQ needs all of a queue's keys on one shard and must never lose a
job to eviction. Files go to a private, versioned S3 bucket; only its `public/` prefix is served by CloudFront.
Supabase's Data API is closed at the database (migration 0073), since the platform never uses it and it would
expose tables to anyone holding the public key.

**Deploys** (`.github/workflows/deploy.yml`, `infra/deploy/deploy.sh`). Each commit on `main` that passes CI is
built once into an immutable `gym-api:<sha>` image, deployed to staging, then waits for a reviewer before
production. GitHub signs in to AWS with OIDC (no stored keys) into a role limited to the two environments.
Each deploy registers new task definitions that differ only in the image, runs the migrations as a one-off
task (and stops there if they fail), then moves the services. Staging rolls; production uses ECS native
blue/green with a 10 minute bake, so a bad release is switched back instantly, and the circuit breaker rolls
back releases whose tasks never become healthy.

New rule from here: because old and new versions run side by side during a deploy, and a switch-back runs the
old version on the new schema, every migration must work with the previous release. Removing or renaming a
column takes two releases: stop using it, then drop it.

**Observability.** OpenTelemetry traces and metrics go to Grafana Cloud over OTLP; errors go to Sentry with no
personal data (no headers, bodies, cookies, query strings or user details). Request rate, errors and latency
per route come from the HTTP instrumentation, labelled with the matched route template (never the raw URL);
the app adds gauges for queue depth by state, the outbox backlog and age, and database connections. Two
dashboards per environment are code (`infra/observability/dashboards`) and run unchanged on a local stack
(`docker compose --profile observability`) that every query was checked against. Grafana alerts on the
service level (multi-window burn of the 99.9% availability budget, p95 above 1 second, events waiting over 2
minutes, new dead letters, database connection waits, readiness and journey checks); CloudWatch alarms cover
what only AWS sees (no healthy targets, 5xx bursts, CPU and memory, Valkey memory, firewall blocks).

**Synthetic checks.** Grafana runs a readiness check every minute from Mumbai, and on staging a k6 journey every
10 minutes: sign in, check in at a kiosk and out, and a signed payment notification accepted while a forged
one is refused (`infra/synthetics`, also run in CI against a live API). Staging signs in with test numbers
(`OTP_TEST_NUMBERS`, fixed code, no SMS); the API refuses to start with them when `DEPLOY_ENV=production`, so
production has the readiness check only.

**Backups.** Three layers: Supabase's daily backups; its point-in-time recovery add-on in production (the RPO
target); and our own daily logical backup, which is provider-independent: `pg_dump` and exact row counts of
every table from one snapshot, kept 35 days in Mumbai and replicated to Hyderabad (a second region inside
India). Every week a drill restores the newest backup into a throwaway server, checks every table row for row
and records the time; CI runs the same drill, including a mismatching backup that must fail it.

## Consequences

- Staging costs roughly USD 150 a month (NAT gateway, load balancer, Fargate, Valkey, WAF, Supabase), and
  production several times that. Both use the smallest sizes that should pass the A18 load test; sizes are
  variables.
- Nothing is live until a person creates the accounts and runs `terraform apply` (README, "First setup").
  Until `AWS_DEPLOY_ROLE_ARN` is set, the deploy workflow skips itself.
- To verify on the first real apply: that Supabase's `postgres` role may create the `BYPASSRLS` roles the
  migrations need, and the database TLS mode (`sslmode=require&uselibpqcompat=true` encrypts; pinning
  Supabase's CA certificate is stricter).
- The drill's time covers restoring the data. A real recovery adds pointing the app at the restored database
  (`docs/runbooks/restore.md`), which is timed in the first staging recovery exercise.
- Per-route metrics label only matched routes; unknown URLs (scanners) do not create new series.
