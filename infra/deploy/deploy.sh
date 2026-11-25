#!/usr/bin/env bash
# Deploys one image to one environment, in this order:
#   1. new task definition revisions of the API and the worker, identical except for the image;
#   2. database migrations as a one-off task (the deploy stops here if they fail; nothing else changed);
#   3. optionally another one-off task (staging: seed-demo);
#   4. the API and the worker move to the new revisions (production: blue/green with a bake time; a
#      release whose tasks never become healthy is rolled back by ECS), and the deploy waits until stable.
# Usage: deploy.sh <staging|production> <image> [seed-demo]
# Needs: ECS_CLUSTER, TASK_SUBNETS (comma-separated), TASK_SECURITY_GROUP, and AWS credentials.
set -euo pipefail
env=$1
image=$2
extra=${3:-}
cluster=${ECS_CLUSTER:?ECS_CLUSTER is not set}
subnets=${TASK_SUBNETS:?TASK_SUBNETS is not set}
security_group=${TASK_SECURITY_GROUP:?TASK_SECURITY_GROUP is not set}
name="gym-$env"
if [ "$extra" = seed-demo ] && [ "$env" = production ]; then
  echo "::error::seed-demo never runs in production"
  exit 1
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Registers a copy of the family's latest revision with the new image; prints the new revision's ARN.
new_revision() {
  aws ecs describe-task-definition --task-definition "$1" --query taskDefinition --output json |
    jq --arg image "$image" '
      .containerDefinitions[0].image = $image
      | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions, volumes,
         requiresCompatibilities, cpu, memory, runtimePlatform}' >"$work/$1.json"
  aws ecs register-task-definition --cli-input-json "file://$work/$1.json" \
    --query taskDefinition.taskDefinitionArn --output text
}

# Runs the API image once with another command; fails unless it exits 0.
run_once() {
  local definition=$1
  shift
  local overrides arn code
  overrides=$(jq -cn --args '{containerOverrides: [{name: "api", command: $ARGS.positional}]}' "$@")
  arn=$(aws ecs run-task --cluster "$cluster" --task-definition "$definition" --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$security_group],assignPublicIp=DISABLED}" \
    --overrides "$overrides" --query 'tasks[0].taskArn' --output text)
  echo "Running $* as $arn"
  aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$arn"
  code=$(aws ecs describe-tasks --cluster "$cluster" --tasks "$arn" \
    --query 'tasks[0].containers[0].exitCode' --output text)
  if [ "$code" != 0 ]; then
    echo "::error::'$*' failed (exit code $code). Logs: CloudWatch /ecs/$name/api"
    exit 1
  fi
}

api=$(new_revision "$name-api")
worker=$(new_revision "$name-worker")
echo "New revisions: $api $worker"

run_once "$api" node dist/migrate.mjs
if [ "$extra" = seed-demo ]; then
  run_once "$api" node dist/seed-demo.mjs
  echo "The kiosk token is in the task's log (CloudWatch /ecs/$name/api), not here."
fi

aws ecs update-service --cluster "$cluster" --service api --task-definition "$api" >/dev/null
aws ecs update-service --cluster "$cluster" --service worker --task-definition "$worker" >/dev/null
# Each wait gives up after 10 minutes; blue/green with a bake time can take longer.
for attempt in 1 2 3; do
  if aws ecs wait services-stable --cluster "$cluster" --services api worker; then
    echo "Deployed $image to $env."
    exit 0
  fi
  echo "Not stable yet (attempt $attempt)."
done
echo "::error::Services did not become stable in 30 minutes; check the ECS console (a failed release rolls back)."
exit 1
