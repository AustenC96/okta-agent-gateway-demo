#!/bin/sh
# Deploys the AWS half of the demo in one go: database + two MCP servers + API Gateway, then uploads the code and loads the data.
#
#   infra/deploy.sh --crm-issuer <url> --hr-issuer <url> [--region us-east-1] [--stack agw-demo] [--profile <aws profile>]
#
# The two issuer URLs come from `npm run okta -- identity` (they identify the Okta authorization servers the MCP servers trust).
# Safe to run again: it updates what changed, re-uploads the code, and skips the data if it is already loaded.
set -eu
cd "$(dirname "$0")/.."

STACK=agw-demo; REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"; CRM=""; HR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --crm-issuer) CRM="$2"; shift 2 ;;
    --hr-issuer) HR="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --stack) STACK="$2"; shift 2 ;;
    --profile) AWS_PROFILE="$2"; export AWS_PROFILE; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$CRM" ] && [ -n "$HR" ] || { echo "Usage: infra/deploy.sh --crm-issuer <url> --hr-issuer <url> [--region r] [--stack name] [--profile p]" >&2; exit 2; }
for tool in aws node zip; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""

aws sts get-caller-identity --query Account --output text >/dev/null 2>&1 || { echo "AWS sign-in failed. Sign in first (for example: aws sso login)." >&2; exit 1; }
echo "Account $(aws sts get-caller-identity --query Account --output text), region $REGION, stack $STACK"

echo; echo "1/4  Creating or updating the stack (a new database takes about 10 minutes)"
aws cloudformation deploy --template-file infra/aws/template.yaml --stack-name "$STACK" --capabilities CAPABILITY_IAM \
  --parameter-overrides "OktaIssuerCrm=$CRM" "OktaIssuerHr=$HR" --tags Project=agent-gateway-demo --no-fail-on-empty-changeset
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
API="$(out McpApiUrl)"; CLUSTER="$(out DbClusterArn)"; SECRET="$(out DbSecretArn)"

echo; echo "2/4  Uploading the MCP server code"
./infra/build.sh >/dev/null
for pair in agw-demo-crm-mcp:crm.handler agw-demo-hr-mcp:hr.handler; do
  fn="${pair%%:*}"; handler="${pair##*:}"
  aws lambda update-function-code --function-name "$fn" --zip-file fileb://infra/mcp.zip --query LastUpdateStatus --output text >/dev/null
  aws lambda wait function-updated --function-name "$fn"
  aws lambda update-function-configuration --function-name "$fn" --handler "$handler" --query LastUpdateStatus --output text >/dev/null
  aws lambda wait function-updated --function-name "$fn"
  echo "     $fn -> $handler"
done

echo; echo "3/4  Loading the fictional CRM and HR data"
DB_CLUSTER_ARN="$CLUSTER" DB_SECRET_ARN="$SECRET" node infra/db/load.mjs

echo; echo "4/4  Checking the public endpoints"
ok=1
for p in crm hr; do
  meta="$(curl -s -o /dev/null -w '%{http_code}' "$API/.well-known/oauth-protected-resource/$p")"
  anon="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' "$API/$p")"
  if [ "$meta" = 200 ] && [ "$anon" = 401 ]; then echo "     /$p: answers publicly and refuses anonymous callers (200 / 401)"; else echo "     /$p: UNEXPECTED (metadata $meta, anonymous call $anon, wanted 200 / 401)"; ok=0; fi
done
[ "$ok" = 1 ] || { echo "An endpoint is not behaving: see docs/TROUBLESHOOTING.md" >&2; exit 1; }

cat <<DONE

AWS is ready. Next:

  1. Register the servers in Okta:   npm run okta -- connect --api-url $API
  2. Put these in .env:
       MCP_API_BASE=$API
       DB_CLUSTER_ARN=$CLUSTER
       DB_SECRET_ARN=$SECRET
       AWS_REGION=$REGION
DONE
