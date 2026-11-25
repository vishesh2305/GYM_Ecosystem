#!/usr/bin/env bash
# Restore drill (target: back in service within 1 hour). Restores the newest backup into a fresh, throwaway
# PostgreSQL server inside this task, checks that every table has exactly the rows the backup recorded, and
# reports how long each part took. Reads s3://$BACKUP_BUCKET/daily/, or $BACKUP_DIR when set. The restored
# copy is deleted when the drill ends; it is never reachable over the network.
set -euo pipefail
started=$(date +%s)
work=$(mktemp -d)
cleanup() {
  pg_ctl -D "$work/pg" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

if [ -n "${BACKUP_DIR:-}" ]; then
  manifest=$(basename "$(find "$BACKUP_DIR" -name '*.json' | sort | tail -1)")
  cp "$BACKUP_DIR/$manifest" "$BACKUP_DIR/${manifest%.json}.dump" "$work/"
else
  : "${BACKUP_BUCKET:?BACKUP_BUCKET or BACKUP_DIR must be set}"
  manifest=$(aws s3 ls "s3://$BACKUP_BUCKET/daily/" | awk '{print $4}' | grep '\.json$' | sort | tail -1)
  aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/daily/$manifest" "$work/"
  aws s3 cp --only-show-errors "s3://$BACKUP_BUCKET/daily/${manifest%.json}.dump" "$work/"
fi
stamp=${manifest%.json}
[ -n "$stamp" ] || { echo "No backup found."; exit 1; }
fetched=$(date +%s)

# A throwaway server listening only on a socket in the work folder.
initdb -D "$work/pg" -U postgres --auth=trust --no-locale --encoding=UTF8 >/dev/null 2>&1
pg_ctl -D "$work/pg" -o "-k $work -c listen_addresses=''" -l "$work/pg.log" -w start >/dev/null
server="host=$work user=postgres"
psql "$server dbname=postgres" --no-psqlrc -qAt -v ON_ERROR_STOP=1 \
  -v roles="$(jq -c .roles "$work/$manifest")" <<'SQL'
SELECT format('CREATE ROLE %I NOLOGIN', r) FROM json_array_elements_text(:'roles') r
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = r) \gexec
CREATE DATABASE restored TEMPLATE template0;
\c restored
DROP SCHEMA public; -- the backup creates it, with its owner and grants
SQL
pg_restore --dbname="$server dbname=restored" --exit-on-error "$work/$stamp.dump"
restored=$(date +%s)

# Every table, exactly the rows the backup counted.
actual=$(psql "$server dbname=restored" --no-psqlrc -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT string_agg(format('SELECT %L AS t, count(*) AS n FROM %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname), ' UNION ALL ')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'app', 'drizzle') \gset
SELECT coalesce(json_object_agg(t, n ORDER BY t), '{}') FROM (:string_agg) x;
SQL
)
differences=$(jq -n --argjson want "$(jq .tables "$work/$manifest")" --argjson got "$actual" \
  '[($want + $got | keys[]) as $t | select($want[$t] != $got[$t]) | "\($t): backup \($want[$t]), restored \($got[$t])"]')
checked=$(date +%s)

tables=$(jq 'length' <<<"$actual")
rows=$(jq '[.[]] | add // 0' <<<"$actual")
total=$((checked - started))
echo "Backup $stamp: $tables tables, $rows rows."
echo "Download $((fetched - started)) s, restore $((restored - fetched)) s, check $((checked - restored)) s; total $total s."
if [ "$(jq length <<<"$differences")" != 0 ]; then
  echo "Restore drill FAILED, rows differ:"
  jq -r '.[]' <<<"$differences"
  exit 1
fi
if [ "$total" -gt 3600 ]; then
  echo "Restore drill FAILED: over the 1 hour target."
  exit 1
fi
echo "Restore drill passed: every table matches the backup, in $total s (target 3600 s)."
