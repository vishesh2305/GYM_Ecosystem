# Cloud infrastructure

Everything the platform runs on, as code. Region: AWS `ap-south-1` (Mumbai) and Supabase Mumbai, so personal
data stays in India (ADR 019).

| Folder                  | What it creates                                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `bootstrap/`            | Once per AWS account: Terraform state bucket, image registry (ECR), the GitHub deploy role (OIDC, no stored keys)        |
| `modules/stack`         | One environment: network, DNS and TLS, load balancer, firewall (WAF), ECS services, Valkey, files bucket and CDN, alarms |
| `modules/database`      | The Supabase project, reachable only from the stack's NAT addresses, TLS enforced                                        |
| `modules/observability` | Grafana Cloud: dashboards, synthetic checks, alerts                                                                      |
| `envs/staging`          | Small and cheap; every commit on `main` deploys here                                                                     |
| `envs/production`       | Two zones, blue/green deploys after approval, deletion protection                                                        |

## Accounts needed (once)

- AWS account, signed in locally (`aws login` or SSO) with administrator rights for `terraform apply`.
- Supabase organisation on a paid plan. Production: switch on the **Point-in-time recovery** add-on in the
  dashboard (it cannot be set through Terraform), and turn off the **Data API** (Settings > API); migration
  0073 also locks it at the database.
- Grafana Cloud stack (Mumbai region) with Synthetic Monitoring switched on: note the OTLP endpoint, the
  instance id and a token with metrics write access, and create a service account token for Terraform.
- Sentry project (Node): note the DSN.
- A domain. Each environment gets a sub-zone (e.g. `staging.example.in`), delegated with four NS records.

## First setup

1. **Bootstrap** (local state; keep the file safe):
   `cd bootstrap && terraform init && terraform apply`. Note `state_bucket`, `image_repository`,
   `deploy_role_arn`.
2. **GitHub**: create the environments `staging` and `production` (production: required reviewers), and set
   the repository variables listed at the top of `.github/workflows/deploy.yml`.
3. **First image**: run the deploy workflow once (Actions > Deploy > Run workflow); its build step pushes
   `gym-api:<sha>` even though there is nothing to deploy to yet.
4. **Staging**:
   ```sh
   cd envs/staging
   cp terraform.tfvars.example terraform.tfvars   # fill in
   export SUPABASE_ACCESS_TOKEN=… GRAFANA_URL=… GRAFANA_AUTH=… GRAFANA_SM_URL=… GRAFANA_SM_ACCESS_TOKEN=…
   terraform init -backend-config="bucket=<state_bucket>"
   terraform apply -target=module.stack.aws_route53_zone.this   # then add the NS records at the registrar
   terraform apply
   ```
   The certificate validates once the NS records are live (minutes to an hour).
5. **App secret**: write every key of `secret_keys` (see `envs/<env>/main.tf`) as one JSON object:
   `aws secretsmanager put-secret-value --secret-id gym-staging/app --secret-string file://secret.json`
   (create `secret.json` outside the repository and delete it afterwards).
   - `DATABASE_URL`: Supabase's session pooler (IPv4), e.g.
     `postgres://postgres.<project_ref>:<terraform output -raw database_password>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require&uselibpqcompat=true`
   - `JWT_PRIVATE_JWK`, `AUTH_SECRET`, `AUTH_ENCRYPTION_KEY`: new for each environment (`pnpm --filter @gym/api keys`,
     `openssl rand -base64 32`).
   - `OTEL_EXPORTER_OTLP_HEADERS`: `Authorization=Basic <base64 of instance-id:token>`.
   - Staging `OTP_TEST_NUMBERS`: `+919910000001:<6 digits>` (the synthetic check's member).
6. **Deploy** `main` (any push, or run the workflow). It migrates the database, then starts the services.
7. **Staging demo data**, for the synthetic check: run the `seed-demo` one-off task (README of
   `.github/workflows/deploy.yml`); it prints the kiosk token for `synthetic_flows`. Then `terraform apply`
   again with `synthetic_flows` filled in.
8. **Production**: steps 4 to 6 in `envs/production`, without test numbers or demo data.

## Checks before every change

CI runs `terraform fmt -check`, `terraform validate` on every root, tflint and trivy (HIGH and CRITICAL)
for each pull request and push. Locally: `terraform plan` in the environment folder; read the plan before
`apply`.

## Things to verify on the first real apply

- The migrations create roles with `BYPASSRLS` (`app_system`, `app_privacy`, `app_admin`). Supabase's
  `postgres` role must be allowed to do that; if not, the first deploy's migration step fails and says so.
- `uselibpqcompat=true` keeps `sslmode=require` meaning "encrypt" (newer `pg` treats `require` as
  `verify-full`). Pinning Supabase's CA certificate (`sslrootcert`) is the stricter follow-up.
