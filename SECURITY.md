# Security notes

This is a demo meant to run on a laptop against a **sandbox** Okta org and a **sandbox** AWS account. Read this before you point it at anything else.

## What is secret, and where it lives

| Item | Where it lives | Rule |
|---|---|---|
| Okta API token (`OKTA_API_TOKEN`) | your `.env` | Super-admin power. Use a sandbox org. Revoke it when you are done. |
| Agent client secrets, GitHub App secret | your `.env` and `.okta-demo.json` | Both files are gitignored. |
| The three fictional users' passwords | `.okta-demo.json` (written once by `npm run okta -- identity`) | Gitignored. The accounts only exist in your org. |
| Database password | AWS Secrets Manager (Aurora creates and owns it) | It never appears in the template, the code, or any file here. |
| `DB_CLUSTER_ARN`, `DB_SECRET_ARN`, `MCP_API_BASE` | your `.env` | Identifiers, not credentials, but they name your AWS account, so do not publish them. |

Never commit `.env` or `.okta-demo*.json`, and never paste either into a chat, ticket or screenshot. `.gitignore` already excludes them.

## What is public, on purpose

The two MCP servers are reachable from the internet through API Gateway, because Okta's gateway has to call them. They are safe to expose
because **every request must carry an Okta access token** that the Lambda verifies itself: RS256 signature against your authorization
server's published keys, issuer, audience, expiry, and then the scope each tool needs. An anonymous or forged call gets `401`.
API Gateway is also throttled (10 requests/second) to cap the cost of anyone hammering the URL. The data behind them is fictional.

## What this demo does not do

- The web app uses plain HTTP and in-memory sessions and is meant for `localhost` only. Do not host it on the internet.
- The Okta Agent Gateway APIs are Beta. Treat the bootstrap script as a convenience for a sandbox, not as infrastructure-as-code for production.
- The demo database is encrypted at rest but has no backups configured beyond Aurora's defaults and deletion protection is off, so it is easy to remove.

## Cleaning up

```sh
npm run okta -- teardown                    # removes the Okta groups, users, agents, gateways, MCP servers and authorization servers it created
aws cloudformation delete-stack --stack-name agw-demo   # removes the database, both Lambdas, the roles and the API
```

Then revoke the API token (Admin Console → Security → API → Tokens) and delete the GitHub App if you created one.
`teardown` removes objects **by name**, so it will also remove same-named objects you made by hand. Run `npm run okta -- status` first if unsure.

## Reporting a problem

Open a GitHub issue. If it involves a credential, do not include the credential: describe where it was exposed and rotate it.
