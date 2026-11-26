#!/bin/sh
# Deploys the three team agents to Amazon Bedrock AgentCore Runtime: builds the agent image, pushes it, and creates the runtimes.
#
#   infra/deploy-agents.sh [--region us-east-1] [--stack agw-demo-agents] [--prefix agw_demo] [--model us.anthropic.claude-haiku-5-5] [--profile <aws profile>]
#
# Run it AFTER `npm run okta -- connect`, because each runtime is locked to its team's gateway (its address and the Okta authorization server
# that issues its tokens), and those only exist once the gateways do. It needs Docker (to build an ARM64 image), the AWS CLI and Node.
# Safe to run again: it rebuilds the image under a new tag and updates the runtimes.
set -eu
cd "$(dirname "$0")/.."

STACK=agw-demo-agents; PREFIX=agw_demo; MODEL=us.anthropic.claude-haiku-5-5; REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --stack) STACK="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --profile) AWS_PROFILE="$2"; export AWS_PROFILE; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
for tool in aws node docker; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }; done
docker info >/dev/null 2>&1 || { echo "Docker is not running. Start it and try again." >&2; exit 1; }
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION" AWS_PAGER=""
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" || { echo "AWS sign-in failed. Sign in first (for example: aws sso login)." >&2; exit 1; }
echo "Account ${ACCOUNT}, region ${REGION}, stack ${STACK}, prefix ${PREFIX}"

echo; echo "1/5  Reading the three gateways from Okta"
GATEWAYS="$(node scripts/okta-bootstrap.mjs gateways)" || exit 1
field() { printf '%s' "$GATEWAYS" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)['$1']['$2']))"; }
ENG_URL="$(field ethan url)"; ENG_ISS="$(field ethan issuer)"; SAL_URL="$(field sofia url)"; SAL_ISS="$(field sofia issuer)"; HR_URL="$(field hannah url)"; HR_ISS="$(field hannah issuer)"
echo "     engineering: $ENG_URL"; echo "     sales:       $SAL_URL"; echo "     hr:          $HR_URL"

deploy() { # $1 = image uri or empty
  aws cloudformation deploy --template-file infra/aws/agents.yaml --stack-name "$STACK" --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
    --tags Project=agent-gateway-demo --parameter-overrides "NamePrefix=$PREFIX" "ImageUri=$1" "ModelId=$MODEL" \
    "EngineeringGatewayUrl=$ENG_URL" "EngineeringGatewayIssuer=$ENG_ISS" "SalesGatewayUrl=$SAL_URL" "SalesGatewayIssuer=$SAL_ISS" "HrGatewayUrl=$HR_URL" "HrGatewayIssuer=$HR_ISS"
}
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

echo; echo "2/5  Creating the image repository and the agents' role"
deploy ""
REPO="$(out RepositoryUri)"

echo; echo "3/5  Building the agent image (ARM64, which is what AgentCore runs) and pushing it"
TAG="$(date +%Y%m%d%H%M%S)"; IMAGE="${REPO}:${TAG}"
aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO%%/*}" >/dev/null
docker buildx build --platform linux/arm64 -t "$IMAGE" --push agents

echo; echo "4/5  Creating or updating the three runtimes"
deploy "$IMAGE"
ENG_ARN="$(out EngineeringRuntimeArn)"; SAL_ARN="$(out SalesRuntimeArn)"; HR_ARN="$(out HrRuntimeArn)"

echo; echo "5/5  Checking each runtime refuses callers without an Okta token"
ok=1
for arn in "$ENG_ARN" "$SAL_ARN" "$HR_ARN"; do
  enc="$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$arn")"
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "https://bedrock-agentcore.${REGION}.amazonaws.com/runtimes/${enc}/invocations?qualifier=DEFAULT" \
    -H 'Content-Type: application/json' -H 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: deploy-check-session-0000000000000000' -d '{"prompt":"hi"}')"
  if [ "$code" = 401 ]; then echo "     ${arn##*/}: refuses anonymous callers (401)"; else echo "     ${arn##*/}: UNEXPECTED ${code}, wanted 401"; ok=0; fi
done
[ "$ok" = 1 ] || { echo "A runtime is not protecting itself: see docs/TROUBLESHOOTING.md" >&2; exit 1; }

cat <<DONE

The agents are ready. Put these in .env:

  ENGINEERING_AGENT_RUNTIME_ARN=${ENG_ARN}
  SALES_AGENT_RUNTIME_ARN=${SAL_ARN}
  HR_AGENT_RUNTIME_ARN=${HR_ARN}
DONE
