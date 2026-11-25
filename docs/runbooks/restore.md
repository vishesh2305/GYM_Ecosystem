# Restoring the database

Targets: lose at most 5 minutes of data (RPO), be back within 1 hour (RTO). Write down the time of each step
as you go; they are the evidence for the log at the end.

## Choose the source

| What happened                                      | Restore from                                        | Data lost                       |
| -------------------------------------------------- | --------------------------------------------------- | ------------------------------- |
| Bad migration or bad data written in the last days | Supabase point-in-time recovery (production add-on) | Up to about 2 minutes           |
| Supabase project lost or unusable                  | Our daily backup (`s3://<backups bucket>/daily/`)   | Since the last 02:30 IST backup |
| Mumbai region unavailable                          | The Hyderabad copy of our daily backup              | Since the last backup           |

## 1. Stop writes (2 minutes)

Scale the worker and the API to zero, so nothing new lands in the damaged database:
`aws ecs update-service --cluster gym-production --service worker --desired-count 0`, then the same for
`api`. The apps show their offline state; workouts keep syncing from phones afterwards.

## 2a. Point-in-time recovery (Supabase)

Supabase dashboard > the project > Database > Backups > Point in time. Choose a moment just before the
problem, review, confirm. The project restores in place and is unavailable meanwhile (the dashboard shows
progress). The connection string stays the same, so go to step 3.

## 2b. Our daily backup

1. Create a new Supabase project in Mumbai (`modules/database`), restricted to the NAT addresses and your own.
2. Download the newest backup (for the Hyderabad copy, use the `-backups-replica-` bucket):
   ```sh
   aws s3 ls s3://<backups bucket>/daily/ | tail -2
   aws s3 cp s3://<backups bucket>/daily/<stamp>.dump . && aws s3 cp s3://<backups bucket>/daily/<stamp>.json .
   ```
3. Create the roles the schema refers to, from the backup's manifest, then restore:
   ```sh
   psql "<new DATABASE_URL>" -v roles="$(jq -c .roles <stamp>.json)" <<'SQL'
   SELECT format('CREATE ROLE %I NOLOGIN', r) FROM json_array_elements_text(:'roles') r
   WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) \gexec
   SQL
   pg_restore --dbname="<new DATABASE_URL>" --exit-on-error <stamp>.dump
   ```
4. Check a few tables against the manifest, e.g. `psql "<url>" -Atc 'select count(*) from members'` and
   `jq '.tables["public.members"]' <stamp>.json`. (The weekly drill checks every table this way.)
5. Put the new `DATABASE_URL` into the app secret (`aws secretsmanager put-secret-value`), and point Terraform
   at the new project.

## 3. Start again (10 minutes)

Run the deploy workflow for the current commit (it migrates, a no-op on restored data, then starts the
services), or set the desired counts back. Check `/v1/ready`, the error rate on the dashboard, and the
synthetic check on staging.

## 4. Afterwards

- Tell gym owners which time range was lost, if any. Payments in the gap: Razorpay's dashboard lists them and
  can re-send their webhooks.
- Add a row below: date, source, the step times, total, data lost, and what to improve.

## Log

The weekly automatic drill writes its timings to CloudWatch (`/ecs/gym-<env>/backup`). Recoveries and the
quarterly manual exercise on staging are recorded here.

| Date | Environment | Source | Total time | Data lost | Notes |
| ---- | ----------- | ------ | ---------- | --------- | ----- |
