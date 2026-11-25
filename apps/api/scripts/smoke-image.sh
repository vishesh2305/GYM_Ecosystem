#!/usr/bin/env bash
# Builds the server image, then checks it the way a deploy uses it: migrate an empty database, start the API
# and the worker with production settings, and wait until the API reports ready. Needs only Docker.
set -euo pipefail
cd "$(dirname "$0")/../../.."
image=${IMAGE:-gym-api:smoke}
name=gym-smoke-$$
envfile=$(mktemp)

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    for c in api worker; do
      echo "--- $c logs" && docker logs "$name-$c" 2>&1 | tail -40 || true
    done
  fi
  docker rm -f "$name-pg" "$name-valkey" "$name-api" "$name-worker" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
  rm -f "$envfile"
}
trap cleanup EXIT

[ -n "${SKIP_BUILD:-}" ] || docker build -f apps/api/Dockerfile -t "$image" .

docker network create "$name" >/dev/null
docker run -d --name "$name-pg" --network "$name" \
  -e POSTGRES_USER=gym -e POSTGRES_PASSWORD=gym -e POSTGRES_DB=gym postgres:17-alpine >/dev/null
docker run -d --name "$name-valkey" --network "$name" valkey/valkey:8-alpine >/dev/null

# Throwaway secrets, and real (not console or fake) providers, because production settings refuse those.
docker run --rm "$image" node -e '
const c = process.getBuiltinModule("node:crypto");
const jwk = c.generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
console.log("JWT_PRIVATE_JWK=" + JSON.stringify(jwk));
console.log("AUTH_SECRET=" + c.randomBytes(32).toString("hex"));
console.log("AUTH_ENCRYPTION_KEY=" + c.randomBytes(32).toString("base64"));' >"$envfile"
cat >>"$envfile" <<EOF
DATABASE_URL=postgres://gym:gym@$name-pg:5432/gym
REDIS_URL=redis://$name-valkey:6379
SMS_PROVIDER=msg91
MSG91_AUTH_KEY=smoke
PUSH_PROVIDER=expo
WHATSAPP_PROVIDER=off
EMAIL_PROVIDER=smtp
SMTP_URL=smtp://localhost:25
PAYMENT_GATEWAY=razorpay
RAZORPAY_KEY_ID=smoke
RAZORPAY_KEY_SECRET=smoke
RAZORPAY_WEBHOOK_SECRET=smoke-webhook-secret
EOF

for _ in $(seq 1 60); do
  docker exec "$name-pg" pg_isready -h 127.0.0.1 -U gym -d gym >/dev/null 2>&1 && break
  sleep 1
done

run() { docker run --network "$name" --env-file "$envfile" "$@"; }
run --rm "$image" node dist/migrate.mjs
run -d --name "$name-api" -p 127.0.0.1::3000 "$image" >/dev/null
run -d --name "$name-worker" "$image" node --import ./dist/instrumentation.mjs dist/worker.mjs >/dev/null

port=$(docker port "$name-api" 3000/tcp | head -1 | cut -d: -f2)
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$port/v1/ready" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/v1/ready"
echo
# Migrating again must be a no-op, and the worker must still be running.
run --rm "$image" node dist/migrate.mjs
[ "$(docker inspect -f '{{.State.Running}}' "$name-worker")" = true ]
echo "Image works: migrations, API and worker."
