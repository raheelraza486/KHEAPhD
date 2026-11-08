#!/usr/bin/env bash
# Build the application image from the current commit and deploy it to the
# live site: the ECS Express service cs9-api-repository in ap-southeast-2.
#
#   1. check: clean checkout at origin/main, AWS session, Docker
#   2. build the image for linux/amd64 and push it to ECR as main-<commit>
#   3. update the service with the new image; every other setting and secret
#      is kept exactly as it is on the service
#   4. wait until the service is stable
#   5. set the load balancer's idle timeout back to 120 seconds if the update
#      reset it (a PDF invoice run takes about half a minute)
#
# Run from anywhere, after `aws login` and with Docker running:
#
#   ./scripts/deploy.sh
#
# Code only: it does not change secrets, settings or the database. Apply new
# migrations first with ./scripts/migrate.sh. To change a key or a setting, see
# the API keys handover document; a new deployment is what makes running tasks
# read a changed secret.
#
# Another AWS account or service: override AWS_REGION, AWS_ACCOUNT_ID,
# ECS_CLUSTER, ECS_SERVICE, ECR_REPOSITORY and ALB_ARN (empty ALB_ARN skips
# step 5). DEPLOY_ANY_COMMIT=1 deploys a commit that is not origin/main.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REGION="${AWS_REGION:-ap-southeast-2}"
ACCOUNT="${AWS_ACCOUNT_ID:-803964123922}"
CLUSTER="${ECS_CLUSTER:-default}"
SERVICE="${ECS_SERVICE:-cs9-api-repository}"
REPOSITORY="${ECR_REPOSITORY:-cs9-api-repository}"
ALB_ARN="${ALB_ARN-arn:aws:elasticloadbalancing:ap-southeast-2:803964123922:loadbalancer/app/ecs-express-gateway-alb-ef8f9afd/eb907d261fa79bf0}"
IDLE_TIMEOUT=120

SERVICE_ARN="arn:aws:ecs:$REGION:$ACCOUNT:service/$CLUSTER/$SERVICE"
REGISTRY="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
TAG="main-$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
IMAGE="$REGISTRY/$REPOSITORY:$TAG"
export AWS_DEFAULT_REGION=$REGION

umask 077
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

step() { printf '\n== %s\n' "$*"; }

step "1. Checks"
[ -z "$(git -C "$ROOT_DIR" status --porcelain)" ] || { echo "The checkout has uncommitted changes; commit or stash them first."; exit 1; }
git -C "$ROOT_DIR" fetch -q origin
if [ "$(git -C "$ROOT_DIR" rev-parse HEAD)" != "$(git -C "$ROOT_DIR" rev-parse origin/main)" ] && [ "${DEPLOY_ANY_COMMIT:-0}" != "1" ]; then
  echo "HEAD is not origin/main. Run: git pull --ff-only origin main (or set DEPLOY_ANY_COMMIT=1)."; exit 1
fi
aws sts get-caller-identity --query Account --output text >/dev/null || { echo "AWS session expired: run aws login first."; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running."; exit 1; }
echo "deploying $TAG to $SERVICE"

step "2. Build and push $IMAGE"
aws ecs describe-express-gateway-service --service-arn "$SERVICE_ARN" --output json > "$WORK/service.json"
# The two public Supabase values are built into the browser code, so they are
# read from the running service and passed to the build.
public() { python3 -c "import json,sys; e={x['name']:x['value'] for x in json.load(open(sys.argv[1]))['service']['activeConfigurations'][0]['primaryContainer']['environment']}; sys.stdout.write(e[sys.argv[2]])" "$WORK/service.json" "$1"; }
docker buildx build --platform linux/amd64 \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$(public NEXT_PUBLIC_SUPABASE_URL)" \
  --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$(public NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)" \
  -t "$IMAGE" --load "$ROOT_DIR/frontend"
aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker push "$IMAGE"

step "3. Update the service (new image, everything else unchanged)"
python3 - "$WORK/service.json" "$WORK/container.json" "$IMAGE" <<'PY'
import json, sys
source, target, image = sys.argv[1:4]
container = json.load(open(source))["service"]["activeConfigurations"][0]["primaryContainer"]
print("from", container["image"])
container["image"] = image
json.dump(container, open(target, "w"), indent=1)
print("to  ", image)
print("settings", ", ".join(e["name"] for e in container.get("environment", [])))
print("secrets ", ", ".join(s["name"] for s in container.get("secrets", [])))
PY
aws ecs update-express-gateway-service --service-arn "$SERVICE_ARN" --primary-container "file://$WORK/container.json" >/dev/null
echo "update sent"

step "4. Waiting for the service to be stable (up to about 10 minutes)"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
aws ecs describe-express-gateway-service --service-arn "$SERVICE_ARN" --query 'service.activeConfigurations[0].primaryContainer.image' --output text

if [ -n "$ALB_ARN" ]; then
  step "5. Load balancer idle timeout"
  current=$(aws elbv2 describe-load-balancer-attributes --load-balancer-arn "$ALB_ARN" --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value" --output text)
  echo "now $current s"
  if [ "$current" != "$IDLE_TIMEOUT" ]; then
    aws elbv2 modify-load-balancer-attributes --load-balancer-arn "$ALB_ARN" --attributes Key=idle_timeout.timeout_seconds,Value=$IDLE_TIMEOUT \
      --query "Attributes[?Key=='idle_timeout.timeout_seconds'].Value" --output text
  fi
fi

step "Done: $TAG is live."
