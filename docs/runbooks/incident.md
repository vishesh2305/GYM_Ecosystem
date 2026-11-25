# Incidents, including personal data breaches

An incident is anything that stops members or gyms from using the platform, loses or corrupts data, or
exposes personal data to someone who should not see it. Alerts arrive by email from Grafana (service level)
and AWS (infrastructure); people can also report one to the support address.

## 1. Take it (5 minutes)

- One person is the incident lead until they hand over. They open a note with the time, what is known, and
  every action taken, with times. This note becomes the report.
- Severity: **S1** platform down, payments wrong, or personal data exposed; **S2** a feature down for many
  gyms; **S3** everything else.

## 2. Look (dashboards first)

- Grafana > Gym platform (production) > "API: traffic, errors and speed": which routes fail or slow down, since
  when. "Background work and database": stuck events, dead letters, connection waits.
- Sentry: the errors behind the 5xx, with the release that raised them.
- AWS: ECS service events (failed deploys, unhealthy tasks), the load balancer's target health, WAF blocks.
- Recent change? The deploy workflow's history shows what went out and when.

## 3. Stop the harm

- A release caused it: during the 10 minute bake the previous version is still ready, and stopping the
  deployment in the ECS console switches traffic back. Later: deploy the previous commit again.
- Data was damaged: `restore.md`.
- An attacker or a leak: revoke what leaked first (rotate the secret in Secrets Manager and redeploy; end the
  affected people's sessions), block addresses in WAF, then investigate.

## 4. Personal data breach (DPDP Act 2023, s.8(6))

A personal data breach is any unauthorised processing, disclosure, access, change, loss or destruction of
personal data that affects its confidentiality, integrity or availability. If one happened, or may have:

1. **Tell the founders and the grievance officer at once**; they own the notices below.
2. **Data Protection Board of India**: an intimation without delay, then a detailed report (what happened,
   when, the data and people affected, the likely impact, what was done, what will prevent it) within 72
   hours of becoming aware, under the DPDP Rules. Confirm the current rule text with counsel.
3. **Each affected person**, without delay, in plain words through the app, SMS or email: what happened,
   what data, the likely consequences, what we did, what they can do, and whom to contact.
4. **CERT-In**: cyber security incidents are reported within 6 hours of noticing them (CERT-In directions
   of 28 April 2022).
5. Keep every record: the incident note, logs (the audit log keeps who did what), and copies of the notices.

Facts to collect for the notices: which tables (`packages/db/src/personal-data.ts` lists what each holds), how
many people and gyms, the time window, how it was found, and whether the data was encrypted.

## 5. Close

- Write the report within 5 working days: timeline, impact, cause, what went well, what to change, owners and
  dates. No blame; the aim is a better system.
- Add an alert or a test that would have caught it earlier.
