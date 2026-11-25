#!/usr/bin/env bash
# Daily logical backup, on top of Supabase's own daily backups and point-in-time recovery: a compressed
# pg_dump of the app's schemas plus a manifest with the exact row count of every table, both taken from the
# same database snapshot, so a restore can be checked row for row (restore-drill.sh).
# Writes <stamp>.dump and <stamp>.json to s3://$BACKUP_BUCKET/daily/ (kept 35 days, copied to Hyderabad),
# or to $BACKUP_DIR when set (local runs and CI). Needs DATABASE_URL (a session, not a transaction, pooler).
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is not set}"
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
schemas=(--schema=public --schema=app --schema=drizzle)

# Hold one repeatable-read transaction open: its snapshot is exported to pg_dump and used for the counts.
coproc PSQL { psql "$DATABASE_URL" --no-psqlrc -qAt -v ON_ERROR_STOP=1; }
ask() { # sends SQL, prints its rows (up to a marker line)
  printf '%s\n\\echo __end__\n' "$1" >&"${PSQL[1]}"
  local line
  while IFS= read -r line <&"${PSQL[0]}"; do
    [ "$line" = __end__ ] && return 0
    printf '%s\n' "$line"
  done
  return 1
}
ask "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" >/dev/null
snapshot=$(ask "SELECT pg_export_snapshot();")

pg_dump "$DATABASE_URL" --snapshot="$snapshot" --format=custom --compress=9 "${schemas[@]}" \
  --file="$work/$stamp.dump"

# Exact row counts of every table, in the same snapshot as the dump.
count_sql=$(ask "SELECT string_agg(format('SELECT %L AS t, count(*) AS n FROM %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname), ' UNION ALL ')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'app', 'drizzle');")
counts=$(ask "SELECT coalesce(json_object_agg(t, n ORDER BY t), '{}') FROM (${count_sql}) x;")
roles=$(ask "SELECT json_agg(rolname ORDER BY rolname) FROM pg_roles WHERE rolname !~ '^pg_';")
ask "COMMIT;" >/dev/null

jq -n --arg at "$stamp" --argjson tables "$counts" --argjson roles "$roles" \
  '{taken_at: $at, tables: $tables, roles: $roles}' >"$work/$stamp.json"

if [ -n "${BACKUP_DIR:-}" ]; then
  cp "$work/$stamp.dump" "$work/$stamp.json" "$BACKUP_DIR/"
else
  : "${BACKUP_BUCKET:?BACKUP_BUCKET or BACKUP_DIR must be set}"
  aws s3 cp --only-show-errors "$work/$stamp.dump" "s3://$BACKUP_BUCKET/daily/$stamp.dump"
  aws s3 cp --only-show-errors "$work/$stamp.json" "s3://$BACKUP_BUCKET/daily/$stamp.json"
fi
echo "Backup $stamp: $(du -h "$work/$stamp.dump" | cut -f1), $(jq '.tables | length' "$work/$stamp.json") tables."
