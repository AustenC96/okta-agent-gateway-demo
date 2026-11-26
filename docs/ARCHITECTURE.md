# Architecture

## The idea in one paragraph

An AI agent should only reach the tools its user's team is meant to use, and every decision should leave evidence. Here, three people each use
**their own team's agent**. The agent talks to **one gateway URL**; the gateway holds the list of tools that team may see and swaps the agent's
token for a token that works with the real tool server. Okta decides *who may use which agent*, the gateway decides *which tools exist*, the
tool server decides *what a token may do*, and Okta's System Log records all of it.

## The path of one tool call

```
 Sofia          Sales Agent            Okta                 Sales Tools gateway        CRM MCP server (Lambda)      Aurora
  │                 │                    │                          │                          │                      │
  │ 1 sign in ─────▶│── authorization ──▶│  Is Sofia in the group   │                          │                      │
  │                 │   code + PKCE      │  this agent is assigned  │                          │                      │
  │                 │◀── access token ───│  to? (Sales) yes → token │                          │                      │
  │                 │                    │                          │                          │                      │
  │ 2 run tool ────▶│── tools/call + token ───────────────────────▶│ Is the tool on the list? │                      │
  │                 │                    │◀─ token exchange (STS) ──│ yes: ask Okta for a      │                      │
  │                 │                    │── CRM access token ─────▶│ token for the CRM server │                      │
  │                 │                    │   (scopes crm:read ...)  │── tools/call + CRM token ▶ verify signature,    │
  │                 │                    │                          │                          │ issuer, audience, exp, │
  │                 │                    │                          │                          │ then the tool's scope  │
  │                 │                    │                          │                          │── SQL (Data API) ─────▶│
  │◀── result ──────│◀───────────────────────────────────────────────────────────── rows ◀────┘◀─────────────────────┘
```

The demo web app plays the agent's part, so you can see each request. The "Under the hood" drawer shows the same flow as a diagram, and marks
each node *observed* (the app saw it), *inferred* (Okta's System Log shows it happened), or *failed*.

## The four layers and where each one lives

| Layer | Decides | Enforced by | Shown in the demo as |
|---|---|---|---|
| 1. Who may use which agent | Only people in the team's group can sign in to that team's agent | Okta: the agent's OIDC app is assigned to exactly one group | **Blocked by Okta** when you try another team's agent |
| 2. Which tools exist | The gateway exposes only the tools switched on for that team | Okta Agent Gateway: *Tool customization* | **Blocked by the gateway** when you ask for another team's tool |
| 3. What a token may do | Each MCP tool needs one scope; the token must carry it | The MCP server (`infra/mcp/core.mjs`), against scopes the custom authorization server granted | **Blocked by the MCP server** (`Forbidden: ... needs the hr:sensitive scope`) |
| 4. Evidence | Every decision is logged | Okta System Log (`agent_gateway.mcp.*`, `app.oauth2.token.*` events) | The green "Okta token exchange" evidence, and the timeline |

Layer 3 is real code with unit tests, but no persona triggers it live, because each team is granted every scope its own tools need.
To demonstrate it, remove one scope from a team's authorization-server rule (for example `hr:sensitive` from the `HR Only` rule) and call `get_compensation` as Hannah.

## Why the pieces are the way they are

- **Gateway connections use "brokered consent" (STS).** The Agent Gateway only accepts `STS_ACCESS_TOKEN` connections: the first time a person uses a service they approve it once, Okta stores that consent per Okta user, and from then on Okta exchanges the agent's token for a service token silently. (Cross App Access / ID-JAG exists in Okta but cannot be used behind a gateway today.)
- **Custom authorization servers for CRM and HR.** They let us define our own scopes and a rule per team's group. GitHub is different: its authorization server is GitHub's, reached through a GitHub App.
- **API Gateway, not a Lambda Function URL.** An MCP client discovers which authorization server to use from the `WWW-Authenticate` header of a `401`. Lambda Function URLs rewrite that header; API Gateway passes it through. API Gateway also gives throttling.
- **Okta, not API Gateway, authorizes.** The API has no authorizer on purpose: the Lambda verifies the RS256 signature, `iss`, `aud` and `exp` itself, so the server stays safe even if called directly.
- **The RDS Data API.** The Lambdas run SQL over HTTPS with IAM, so there is no VPC, no connection pool and no database password in code (Aurora keeps the password in Secrets Manager, and the Lambda role may read only that one secret).
- **Aurora Serverless v2 that can pause.** Idle cost is near zero; the price is about 15 seconds on the first call after a pause. The MCP servers retry for up to 24 seconds so that call is slow rather than failed, and `npm run preflight` wakes it beforehand.
- **Tools are read-mostly.** The web page only runs read-only tools. `update_deal_stage` exists (it needs `crm:write`) to show a write scope, but the page does not call it.

## Everything that gets created

### Okta (by `npm run okta`)

| Object | Names |
|---|---|
| Groups | `Engineering`, `Sales`, `HR` |
| Users (in those groups) | `ethan.park@`, `sofia.reyes@`, `hannah.cho@agentgateway.demo` |
| Custom authorization servers | `CRM MCP` (scopes `crm:read`, `crm:write`; rule `Sales Only`), `HR MCP` (`hr:read`, `hr:sensitive`; rule `HR Only`) |
| MCP server records | `GitHub MCP`, `CRM MCP`, `HR MCP` |
| Credentials (brokered consent) | GitHub App credentials, `Sales STS Client`, `HR STS Client` (each backed by an OIDC app named `<MCP> STS Client`) |
| Gateways | `Engineering Tools` (`/mcp/servers/engineering-tools`), `Sales Tools` (`sales-tools`), `HR Resources` (`hr-resources`) |
| Tools switched on | Engineering: `get_me`, `search_repositories`, `get_file_contents`. Sales: `search_customers`, `get_customer`, `list_deals`, `update_deal_stage`. HR: `list_employees`, `get_employee`, `get_compensation` |
| Agents (each an OIDC app assigned to one group) | `Engineering Agent`, `Sales Agent`, `HR Agent` |
| Delegation links | one per agent, to its own gateway only |

The names matter: the app, `npm run preflight` and the tool names (`CRMMCP_search_customers`, ...) rely on them. Okta derives the tool prefix from the MCP server's display name.

### AWS (by `infra/aws/template.yaml`, stack `agw-demo`)

| Resource | Details |
|---|---|
| Aurora PostgreSQL Serverless v2 cluster `demo-db` + one `db.serverless` instance | 0 to 2 ACUs, pauses after an hour idle, Data API on, encrypted, password managed by Secrets Manager |
| Lambda `agw-demo-crm-mcp`, `agw-demo-hr-mcp` | Node.js, arm64, 256 MB, 29 s timeout, settings from environment variables |
| IAM role per Lambda | CloudWatch Logs, `rds-data:ExecuteStatement` on the cluster, `secretsmanager:GetSecretValue` on the cluster's secret, nothing else |
| API Gateway HTTP API `agw-demo-mcp` | Routes `ANY /crm`, `ANY /hr` and the two `/.well-known/oauth-protected-resource/...` paths; throttled to 10 requests/s |
| Log groups | 14 days' retention |

### Data

`infra/db/01-schema.sql` and `02-seed.sql`: schema `crm` (8 customers, 10 deals) and schema `hr` (8 employees, compensation). All fictional.

## The web app

`server.js` (Express) plays the agent: it does OAuth 2.0 authorization code with PKCE against the *agent's* Okta app, then speaks MCP (JSON-RPC over HTTP) to the gateway with that token.
Each person is a "persona" (`personas.js`) with their own client, gateway URL and callback. Results are classified into verdicts by `verdicts.js`,
and when `OKTA_API_TOKEN` is set the app reads Okta's System Log to attach evidence to each call. Sessions are in memory and the app is for `localhost` only.
