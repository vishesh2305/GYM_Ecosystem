# 015. Training data and offline sync

- Status: accepted
- Date: 2026-11-25

## Decision

**Ownership.** Training data belongs to the person, not to a gym: it follows them between gyms and stays when
they leave a gym. The tables (`exercises`, `workouts`, `workout_sets`, `workout_templates`,
`personal_records`, `body_metrics`) carry `user_id` instead of `tenant_id` and are protected by
`app.enable_user_rls`: rows are visible and writable only for `app.user_id` (`withUser`). The shared exercise
library (`user_id` null, seeded by migration with stable slugs) is readable by everyone and writable by no one.
Gyms and coaches cannot see members' training yet.

**Offline sync with PowerSync.** Phones keep a local SQLite copy filled by the PowerSync service, which reads
the `powersync` publication through logical replication. Because the service bypasses RLS, the sync rules in
`packages/db/powersync/sync-rules.yaml` are the only filter: a global `exercise_library` bucket and a
per-person `my_training` bucket keyed by `request.user_id()`. A database test runs every sync rule query and
checks that a phone receives the library and its owner's rows only, that every synced table is in the
publication and that each has forced RLS. PowerSync authenticates phones with their normal access token,
verified against `GET /v1/auth/jwks` (Ed25519, `kid` = key thumbprint, same issuer and audience).

**Uploads.** Phones never write through PowerSync. Their upload queue goes to `POST /v1/me/sync` as a batch of
`PUT` (whole row, upsert), `PATCH` (changed columns) and `DELETE` operations, applied in order in one
transaction under `withUser`:

- Ids are UUIDs made on the phone, so a retried batch updates the same rows and never duplicates them.
- Each table has a column allowlist with validation; `user_id`, ids and timestamps from the phone are ignored.
  An invalid value or an unknown table rejects the whole batch (400) and the app drops it.
- `updated_at` is always server time. Conflicts are last-write-wins per column, in the order changes reach the
  server (two phones editing different columns of one set both keep their change).
- A change to a row (or under a parent) that no longer exists, or that belongs to someone else, is skipped and
  counted as `skipped` rather than blocking the queue. Upserting another person's id fails RLS: 403.
- Deleting an own exercise archives it, so sets logged with it keep their exercise.

**Personal records.** After each batch the server recalculates the records of every exercise it touched from
all the person's sets (`personalBests` in the domain package): `max_weight`, `est_1rm` (Epley, up to 12 reps)
and `best_set_volume` for weight-and-reps exercises, `max_reps`, `max_duration` or `max_distance` otherwise.
Warm-ups and sets not ticked off do not count; on a tie the earlier set keeps the record. A better value appends
`training.personal_record_set` to the outbox; a lower one after a deletion or edit replaces the record quietly.
Records are read-only for the app and arrive through sync.

**Units.** Weight is kg and other values (RPE, body metrics) are double precision rather than integer grams,
because PowerSync turns `numeric` into text on the phone and the values entered (e.g. 62.5 kg) are exact in
binary floating point; derived values are rounded to 0.01.

## Not yet done

- Coaches and gyms seeing a member's workouts (needs consent), programmes and programme assignments.
- Deploying the PowerSync service and its replication role (A17).
- Exercise how-to videos (`media_key` is empty until filmed), progress photos.
- Monthly partitioning of `workout_sets`: one table with a (user, exercise) index is enough at launch volumes.
- Personal data export and deletion for training tables (A16 registry).
