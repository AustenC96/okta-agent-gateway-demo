# Setup guide

This takes you from an empty folder to the demo running at http://localhost:8080 in your own Okta org and AWS account.
Allow about **45 minutes**, most of it waiting for AWS to create the database. You do not need to know AWS or the Okta APIs: each step says what it does and how to tell it worked.

## What you will have at the end

```
   you (browser)                          Okta org                                   your AWS account
 ┌──────────────┐   sign in    ┌──────────────────────────────┐
 │ demo web app │────────────▶ │ 3 groups, 3 users            │
 │ localhost    │              │ 3 agents ─▶ 3 gateways ──────┼──▶ GitHub MCP server (github.com)
 └──────────────┘              │ 2 custom authorization       │      ┌───────────────────────────────────────┐
                               │   servers (CRM, HR)          ├──▶ API Gateway ─▶ Lambda (CRM MCP) ─┐        │
                               └──────────────────────────────┘      │           Lambda (HR MCP)  ─┼▶ Aurora │
                                                                     └─────────────────────────────┴─────────┘
```

Three fictional people (Ethan in Engineering, Sofia in Sales, Hannah in HR) each get their own agent, gateway and tools. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full picture.

## Before you start

Check each of these. If one is missing, the step that needs it will fail.

| You need | How to check | Notes |
|---|---|---|
| **An Okta org with Agent Gateway enabled** | In the Admin Console you can open **Security → Agent Gateway** | Agent Gateway ("Okta for AI Agents") is a Research Release (Beta). If the menu is missing, ask your Okta contact to enable it. Use a **sandbox/preview** org, not production. |
| **Super administrator rights** in that org | You can open **Security → API → Tokens** | The bootstrap script creates groups, users, apps and gateways. |
| **An AWS account** you can create resources in | `aws sts get-caller-identity` prints an account | A sandbox account is ideal. You need to be able to create CloudFormation stacks, IAM roles, Aurora, Lambda and API Gateway. The account needs a **default VPC** (every account has one unless it was deleted), or pass your own subnet group to the stack. |
| **AWS CLI v2**, signed in | `aws --version` shows `aws-cli/2.x` | Sign in with `aws sso login` or `aws configure`. Set the region you want (for example `export AWS_REGION=us-east-1`). |
| **Node.js 20 or newer** | `node -v` | |
| **`zip` and `curl`** | `zip -v`, `curl --version` | Preinstalled on macOS and most Linux. |
| **A GitHub account** (only for Ethan's team) | | Used to create one GitHub App. You can skip Engineering and still demo Sales and HR. |

## Part 1: Get the code and your Okta API token (5 minutes)

```sh
git clone https://github.com/AustenC96/okta-agent-gateway-demo.git
cd okta-agent-gateway-demo
npm install
cp .env.example .env
```

Create an API token. In the Admin Console: **Security → API → Tokens → Create token**, name it `agent-gateway-demo`, and copy the value (Okta shows it once).
Open `.env` in an editor and set two values:

```
OKTA_ORG_URL=https://your-org.okta.com          # or https://your-org.oktapreview.com. No trailing slash.
OKTA_API_TOKEN=00xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

> The token has the power of the administrator who made it. Use a sandbox org, keep it only in `.env` (gitignored), and revoke it when you finish the demo period.

**Check it worked:**

```sh
npm run okta -- status
```

You should see a list of checkmarks and `!  ... missing` lines (everything is missing because nothing is built yet). If instead you see
`HTTP 401`, the token or org URL is wrong; `HTTP 403` or `404` on `/workload-principals/...` means Agent Gateway is not enabled in the org.

## Part 2: Create the Okta people and servers (2 minutes)

```sh
npm run okta -- identity --add-me
```

This creates, only if they do not already exist:

- **Groups** `Engineering`, `Sales`, `HR`. The group is what ties a person to their team's agent.
- **Three fictional users**, `ethan.park@agentgateway.demo`, `sofia.reyes@agentgateway.demo`, `hannah.cho@agentgateway.demo`, one per group, with random passwords. The domain is not real and never receives email.
  The passwords are saved to **`.okta-demo.json`** (gitignored). Open that file when you want to sign in as a person.
- **Two custom authorization servers**, `CRM MCP` and `HR MCP`. Each defines the scopes its data needs (`crm:read`, `crm:write`, `hr:read`, `hr:sensitive`) and a rule that only lets the matching group get tokens.
- **`--add-me`** adds *you* (the token's owner) to all three groups. You need that to approve one-time consents in Part 5 and to test each agent as an admin.

It ends by printing two **issuer URLs** (CRM and HR). Keep them for Part 3. They are also saved in `.okta-demo.json`.

Safe to run again: it only creates what is missing.

## Part 3: Deploy the AWS side (about 15 minutes, mostly waiting)

Make sure the AWS CLI is signed in to your sandbox account and region, then run (paste the two issuer URLs from Part 2):

```sh
infra/deploy.sh \
  --crm-issuer https://your-org.okta.com/oauth2/aus...CRM \
  --hr-issuer  https://your-org.okta.com/oauth2/aus...HR
```

Options: `--region us-east-1`, `--stack agw-demo`, `--profile <aws profile>`.

It does four things and prints a heading for each:

1. **Creates a CloudFormation stack** (`agw-demo`): an Aurora Serverless v2 PostgreSQL database, two Lambda functions (the CRM and HR MCP servers) with one least-privilege IAM role each, and an API Gateway in front of them. The first run takes about 10 minutes because of the database.
2. **Uploads the MCP server code** to both Lambdas (`infra/mcp/`, no dependencies).
3. **Loads the fictional data**: 8 customers and 10 deals in a `crm` schema, 8 employees and their compensation in an `hr` schema.
4. **Smoke-tests the public endpoints**: each must answer its public metadata with `200` and refuse an anonymous call with `401`.

**Check it worked:** the last lines say `AWS is ready` and print something like:

```
MCP_API_BASE=https://abc123xyz.execute-api.us-east-1.amazonaws.com
DB_CLUSTER_ARN=arn:aws:rds:us-east-1:123456789012:cluster:demo-db
DB_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:rds!cluster-...
```

**Put those three lines (plus `AWS_REGION=`) into `.env`.** Quote nothing; if you export them in a zsh shell instead, wrap the secret ARN in single quotes because it contains `!`.

Cost: Aurora is configured to pause when idle (no compute charge while paused; the first call after a pause takes about 15 seconds, which `npm run preflight` handles). Lambda and API Gateway cost effectively nothing at demo volumes. See the [Aurora Serverless v2 pricing](https://aws.amazon.com/rds/aurora/pricing/) for current rates, and delete the stack when you are done.

## Part 4: Create a GitHub App for Ethan (10 minutes, optional)

Ethan's team uses GitHub's own MCP server. Okta needs a GitHub App so that each person can approve access to *their* GitHub data once. **Skip this part** if you only want Sales and HR; Part 5 will report Engineering as incomplete and carry on.

> This is the one part that I could not check against Okta's published instructions. It reproduces what worked in the original build. If a field name has moved in GitHub's UI, match the intent: *a GitHub App whose callback URL is Okta's STS callback, with read access to repository contents.*

1. On GitHub: **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. **Name** anything unique (for example `Okta Agent Gateway demo (yourname)`). **Homepage URL** anything valid.
3. **Callback URL**: `https://<your-okta-org-host>/oauth2/v1/sts/callback` (for example `https://your-org.okta.com/oauth2/v1/sts/callback`).
4. **Webhook**: untick *Active*.
5. **Repository permissions**: *Contents: Read-only* and *Metadata: Read-only*. Nothing else.
6. Create the app. On its page copy the **Client ID**, then **Generate a new client secret** and copy it (GitHub shows it once).
7. **Install App** (left menu) on your own account, so its tokens can read your repositories.
8. Put both values in `.env`:

```
GITHUB_APP_CLIENT_ID=Iv...
GITHUB_APP_CLIENT_SECRET=...
```

## Part 5: Connect everything in Okta (5 minutes plus two or three clicks)

Paste the `MCP_API_BASE` value from Part 3:

```sh
npm run okta -- connect --api-url https://abc123xyz.execute-api.us-east-1.amazonaws.com
```

For each team it creates, only if missing:

| Object | What it is for |
|---|---|
| **MCP server record** (`GitHub MCP`, `CRM MCP`, `HR MCP`) | Tells Okta where the real tool server is (your API Gateway `/crm`, `/hr`, or GitHub's endpoint) |
| **Credentials, "brokered consent"** | The OAuth client Okta uses to get a person's token for that server. For CRM and HR the script also creates an "STS client" app assigned to the team's group |
| **Gateway** (`Engineering Tools`, `Sales Tools`, `HR Resources`) | The single URL an agent talks to. It decides which tools are visible |
| **Connection + tools** | Links a gateway to its MCP server and switches on exactly the tools that team should have (3 for GitHub, 4 for CRM, 3 for HR) |
| **Agent** (`Engineering Agent`, `Sales Agent`, `HR Agent`) | The agent's own OIDC app, assigned **only** to that team's group, so only that team can sign in to it |
| **Delegation link** | Allows that one agent to call that one gateway |

**One interactive moment.** To read each MCP server's tool list, Okta needs *you* to approve a one-time consent. When that happens the script pauses and prints:

```
One-time consent needed for CRM MCP. Open this link in a browser where you are signed in to Okta as an administrator
who belongs to the team's group, approve it, then come back here:
    https://your-org.okta.com/oauth2/v1/sts/redirect?dataHandle=...
Press Enter after approving...
```

Open the link in a browser where you are signed in to the Admin Console (this is why `--add-me` put you in the groups), approve, and press Enter.
For the GitHub server you will be sent to GitHub to authorize the app you made in Part 4. If the script is not running in an interactive terminal, it prints the link and stops: approve, then run the same command again. Nothing is repeated.

**Check it worked:**

```sh
npm run okta -- status
```

It should end with `Everything exists`. In the Admin Console you can see the same objects at **Security → Agent Gateway** (gateways: *AI agents*, *Resource connections* and *Tool customization* tabs) and **Applications → MCP Servers**.

## Part 6: Configure the app and check it (5 minutes)

Print the agent values:

```sh
npm run okta -- env
```

Copy its lines into `.env` (it prints `OKTA_ORG_URL`, `GATEWAY_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `SALES_AGENT_...`, `HR_AGENT_...`). The agent secrets are only available this once, from `.okta-demo.json`, because Okta does not show them again.
Your `.env` should now match `.env.example` with no blanks (except the optional GitHub lines).

Then run the pre-flight check:

```sh
npm run preflight
```

It verifies Okta, AWS and `.env`, wakes the database and checks that the tables both MCP servers read are present and correct, confirms both public endpoints refuse anonymous callers, and starts the app. A good run ends with:

```
READY
  Open http://localhost:8080 and pick someone.
```

Anything marked `✗` says what is wrong. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Part 7: Try it

Open http://localhost:8080 and choose **Sofia Reyes**. Click through **Discover → Sign in → Connect**; sign in with the user's email and the password saved in `.okta-demo.json` (the first sign-in may ask you to set up the multi-factor authentication your org's policy requires).
Run `search_customers`: you should see **Allowed**. Then try *another team's agent* and *a tool it doesn't have*, and watch the verdicts.
[PRESENTING.md](PRESENTING.md) has the full 10-minute script.

The first time each person calls a tool on a service, they are shown a **one-time consent** link. Approve it and retry. For Ethan this is a GitHub authorization; Okta remembers it per Okta user.

## Rebuilding, resetting and removing

| I want to... | Run |
|---|---|
| Get ready before each presentation | `npm run preflight` |
| Reset the data to its original values | `npm run seed -- --reset` |
| See what exists in Okta | `npm run okta -- status` |
| Rehearse the Okta setup next to a real one | add `--tag test` to any `okta` command: every name gets ` test` appended. Remove with `npm run okta -- teardown --tag test` |
| Remove the demo from Okta | `npm run okta -- teardown` |
| Remove the demo from AWS | `aws cloudformation delete-stack --stack-name agw-demo` |

## What was and was not tested

- Tested end to end against a real Okta org: the three personas' flows, the identity step, the connect step (resumed after a deliberate interruption), `status`, and `teardown` of a tagged copy.
- Tested offline: the whole web app and both MCP servers (`npm test`, 83 tests), and the CloudFormation template with `cfn-lint`.
- **Not yet exercised on a clean account:** `infra/deploy.sh` against AWS, and the GitHub-specific path inside `okta connect` that creates Okta's record of GitHub's authorization server. If either fails, the error message names the step; the equivalent console steps are under **Applications → MCP Servers** in the Admin Console.
- A *"Blocked by the MCP server"* verdict (a tool refusing because the token lacks a scope) is implemented and unit-tested, but none of the three personas triggers it, because each person is granted every scope their own team's tools need.
