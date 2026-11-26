# Troubleshooting

Start with `npm run preflight -- --check` (changes nothing) and `npm run okta -- status`. Between them they find most problems. Each ✗ line says what is wrong.

## Setup problems

| Symptom | Likely cause | Fix |
|---|---|---|
| `npm run okta` says `HTTP 401` | Wrong `OKTA_ORG_URL` or token, or the token was revoked | Recreate the token (Security → API → Tokens). The URL must have no trailing slash and no `-admin` in it |
| `HTTP 403` / `404` on `/workload-principals/...` | Agent Gateway is not enabled in the org, or the token's admin is not a super admin | Ask your Okta contact to enable Okta for AI Agents; create the token as a super admin |
| `identity` fails creating users with a password error | Your org's password policy is stricter than the generated passwords | Relax the policy for the sandbox, or create the three users by hand with the logins in `personas.js` and put them in the groups |
| `infra/deploy.sh`: `AWS sign-in failed` | The AWS CLI has no valid session | `aws sso login` (or `aws configure`), then confirm `aws sts get-caller-identity` |
| Stack fails on the database | The engine version does not support the Data API in your region, or no default VPC | Pass another version (`EngineVersion`), or a subnet group (`DbSubnetGroupName`) with `aws cloudformation deploy --parameter-overrides` |
| `deploy.sh` stops at step 4 with `UNEXPECTED (metadata ..., anonymous call ...)` | The Lambda code did not upload, or the routes are missing | Run it again. Look at `aws logs tail /aws/lambda/agw-demo-crm-mcp`. A `503 Code not uploaded yet` means step 2 did not finish |
| `connect` says `needs the GitHub App client ID and secret` | Part 4 skipped | Add `GITHUB_APP_CLIENT_ID/SECRET` to `.env` and run it again, or ignore: Sales and HR still work |
| `connect` prints a consent link and stops | The terminal is not interactive | Approve the link as an admin who is in the team's group, then run the same command again |
| `connect` fails with `tool ... was not discovered` | The MCP server does not answer, so Okta could not list its tools | Check `curl -i -X POST $MCP_API_BASE/crm -d '{}'` returns `401` with a `www-authenticate` header. Then run `connect` again |
| `deploy-agents.sh`: `Docker is not running` | Docker Desktop (or the daemon) is stopped | Start it; `docker info` must work |
| `deploy-agents.sh` is slow on an Intel machine | The ARM64 image is built by emulation | Expected; allow several minutes, or build on an Apple Silicon or ARM machine |
| `deploy-agents.sh`: `No gateway found at ...` | `npm run okta -- connect` has not created the gateways yet | Run `connect` first (Part 5), then this again |
| `deploy-agents.sh` fails creating a runtime with an access-denied or model error | The Bedrock model is not enabled, or your role cannot create AgentCore runtimes | Enable the model (Bedrock console, Model access) and check the `converse` command in the setup guide's prerequisites; ask your AWS admin about AgentCore permissions |
| The agent ARNs changed after re-running `deploy-agents.sh` | CloudFormation replaces the runtimes when the image changes | Copy the three printed ARNs into `.env` and restart (`npm run preflight`) |
| `status` shows `!` for something you created by hand | The names differ from the ones the demo expects | Rename it (see the table in [ARCHITECTURE.md](ARCHITECTURE.md)) or let `connect` create the expected one |

## Running problems

| Symptom | Likely cause | Fix |
|---|---|---|
| Okta shows an error page when signing in | The agent's app has no group assigned, a different group than the user's, or the redirect URI is wrong | The agent's app must list `http://localhost:8080/authorization-code/callback` and be assigned only to the team's group. `npm run preflight` reports both |
| The chat answers `AgentCore refused the token` | The sign-in token expired (about an hour), or it was issued for a different team's gateway | Sign in again. Each runtime accepts only its own team's gateway tokens |
| The chat says the agent could not be reached, or returns 5xx | The runtime is not `READY`, the ARN in `.env` is stale, or Claude is not enabled | `npm run preflight -- --check` reports each runtime; check the ARNs and the Bedrock model access |
| The chat shows `[ValidationException ... temperature ...]` or a model error | The chosen Claude model rejects a setting, or is not available in the region | Pass a model your region offers with `deploy-agents.sh --model`; the code sets no sampling options |
| The agent says it has "no tool" for a break-it prompt instead of trying | Claude chose to decline | Ask more directly, or use **Sign in to another team's agent**, which is deterministic |
| A tool step stays running for 15–30 s | Aurora is waking from its pause | Wait; run `npm run preflight` beforehand next time |
| "Not set up" on a person's card | Their agent client ID or secret is missing from `.env` | `npm run okta -- env` and copy the values; restart `npm start` |
| Tools list is empty, or says "Connection required" | The person has not given consent, or the connection's credentials are stale | Click the consent link. If it persists, check that the gateway's connection is ACTIVE with the tools on (`npm run okta -- status`) |
| `Connection required: visit https://.../sts/redirect?...` | Same as above (Okta returns it as a normal tool result, not an error) | Open the link, approve, retry |
| A call is slow, then says the database is waking up | Aurora had paused | Wait about 15 seconds and retry. `npm run warm` before a session |
| `Forbidden: ... needs the ... scope` | The token lacks the scope (correct behavior) | Expected if you removed a scope from the authorization server's rule |
| Okta evidence never turns green | `OKTA_API_TOKEN` is missing, or the System Log is lagging | Set the token in `.env`. Denied events can take about 15 seconds to appear |
| The page does not update after a restart | A stale tab from the previous run | Reload. A restart resets sessions by design |
| `npm run preflight` says `Port 8080 is used by another program` | Something other than this app holds the port | `lsof -i :8080`, stop it or set `PORT` |
| `zsh: event not found` when exporting the secret ARN | `!` in the ARN | Wrap the value in single quotes |

## Understanding what Okta is telling you

The gateway answers an unknown or removed tool with JSON-RPC error `-32602` ("invalid params"), and Okta logs `agent_gateway.mcp.tool.call` with outcome DENY. Consent-required comes back as an HTTP 200 *tool result* containing `Connection required: visit ...`, not an HTTP error.
In the System Log (Reports → System Log) filter by `eventType sw "agent_gateway"` to see the gateway's own events, and `app.oauth2.token.grant.oauth_sts` for the token exchanges.

## Starting over

`npm run okta -- teardown` and `aws cloudformation delete-stack --stack-name agw-demo`, then repeat Parts 2 to 6 of [SETUP.md](SETUP.md). Delete `.okta-demo.json` first so new passwords and secrets are recorded.
