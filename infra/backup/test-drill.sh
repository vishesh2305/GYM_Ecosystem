#!/usr/bin/env bash
# CI check of backups: a database with the real schema and the demo gym is backed up, restored into a
# throwaway server and checked row for row; then a backup whose manifest disagrees must make the drill fail.
# Uses the server image built by apps/api/scripts/smoke-image.sh (API_IMAGE, default gym-api:smoke).
set -euo pipefail
cd "$(dirname "$0")/../.."
api_image=${API_IMAGE:-gym-api:smoke}
name=gym-drill-$$

cleanup() {
  docker rm -f "$name-pg" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  docker volume rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker build -q -t gym-backup:test infra/backup >/dev/null
docker network create "$name" >/dev/null
docker volume create "$name" >/dev/null
docker run --rm -v "$name:/backups" --user root gym-backup:test chown postgres /backups
docker run -d --name "$name-pg" --network "$name" \
  -e POSTGRES_USER=gym -e POSTGRES_PASSWORD=gym -e POSTGRES_DB=gym postgres:17-alpine >/dev/null
for _ in $(seq 1 60); do
  docker exec "$name-pg" pg_isready -h 127.0.0.1 -U gym -d gym >/dev/null 2>&1 && break
  sleep 1
done

db="DATABASE_URL=postgres://gym:gym@$name-pg:5432/gym"
docker run --rm --network "$name" -e "$db" "$api_image" node dist/migrate.mjs >/dev/null
docker run --rm --network "$name" -e "$db" -e DEPLOY_ENV=staging "$api_image" node dist/seed-demo.mjs >/dev/null

backup() { docker run --rm --network "$name" -v "$name:/backups" -e BACKUP_DIR=/backups "$@"; }
backup -e "$db" gym-backup:test backup.sh
backup gym-backup:test restore-drill.sh

# The drill must notice a restore that does not match the backup.
# shellcheck disable=SC2016 # expanded inside the container, not here
backup --entrypoint bash gym-backup:test -c \
  'f=$(ls /backups/*.json); jq ".tables[\"public.members\"] += 1" "$f" > /tmp/m && cp /tmp/m "$f"'
if backup gym-backup:test restore-drill.sh; then
  echo "The drill passed a restore that does not match its backup."
  exit 1
fi
echo "Backup and restore drill work, and a mismatch fails the drill."
