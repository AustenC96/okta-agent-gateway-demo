# Architecture

## The idea in one paragraph

An AI agent should only reach the tools its user's team is meant to use, and every decision should leave evidence. Here, three people each chat with
**their own team's AI agent**: a real Claude-powered agent hosted on Amazon Bedrock AgentCore. The agent talks to **one gateway URL**, using the *person's own* Okta token; the gateway holds
the list of tools that team may see and swaps that token for one that works with the real tool server. Okta decides *who may use which agent*, the gateway decides *which tools exist*,
the tool server decides *what a token may do*, and Okta's System Log records all of it. The model never holds a credential.

## The path of one question

```
 Sofia     web app (localhost)   AgentCore: Sales agent        Okta            Sales Tools gateway        CRM MCP (Lambda)     Aurora
   │              │                      │                       │                    │                         │                │
   │ 1 sign in ──▶│── authorization code + PKCE ───────────────▶ │ Is Sofia in the group this agent's app is   │                │
   │              │◀──────────────── access token ─────────────── │ assigned to (Sales)? yes → token for the    │                │
   │              │                      │                       │ SALES GATEWAY (aud = its URL)               │                │
   │ 2 ask ──────▶│── prompt + Sofia's token ─▶ verify the token │                    │                         │                │
   │              │                      │  (issuer + audience of THIS team's gateway) │                         │                │
   │              │                      │── Claude chooses a tool from tools/list ───▶ Is the tool on the list?│                │
   │              │                      │   (Sofia's token, unchanged)                │ yes: exchange the token │                │
   │              │                      │                       │◀── token exchange ──│ with Okta for a CRM     │                │
   │              │                      │                       │── CRM token ───────▶│ token (crm:read ...)    │                │
   │              │                      │                       │                    │── tools/call + CRM token ▶ verify sig,   │
   │              │                      │                       │                    │                         │ iss, aud, exp, │
   │              │                      │                       │                    │                         │ then the scope │
   │              │                      │                       │                    │                         │── SQL ────────▶│
   │◀── answer, streamed, with each tool step ◀──────────────────────────────────────────────── rows ◀─────────┴────────────────┘
```

The web app signs the person in and carries their token to the agent; it does not choose tools. The "Under the hood" drawer shows the same flow as a diagram and marks
each node *observed* (the app saw it), *inferred* (Okta's System Log shows it happened), or *failed*.

## The layers and where each one lives

| Layer | Decides | Enforced by | Shown in the demo as |
|---|---|---|---|
| 1. Who may use which agent | Only people in the team's group can sign in to that team's agent | Okta: the agent's OIDC app is assigned to exactly one group | **Blocked by Okta** (the page then shows that agent as locked) |
| 1b. Who may call the agent runtime | A runtime accepts only tokens issued by its own team's gateway | AgentCore's JWT authorizer, pinned to that gateway's issuer and audience | A foreign token gets `401` at the runtime's front door |
| 2. Which tools exist | The gateway exposes only the tools switched on for that team | Okta Agent Gateway: *Tool customization* | **Blocked by the gateway** when the agent asks for another team's tool |
| 3. What a token may do | Each MCP tool needs one scope; the token must carry it | The MCP server (`infra/mcp/core.mjs`), against scopes the custom authorization server granted | **Blocked by the MCP server** (`Forbidden: ... needs the hr:sensitive scope`) |
| 4. Evidence | Every decision is logged | Okta System Log (`agent_gateway.mcp.*`, `app.oauth2.token.*` events) | The "Okta log" line on the verdict card and the green "Token exchange" evidence |

Layer 3 is real code with unit tests, but no persona triggers it live, because each team is granted every scope its own tools need.
To demonstrate it, remove one scope from a team's authorization-server rule (for example `hr:sensitive` from the `HR Only` rule) and ask for compensation as Hannah.

### The "try to break it" prompts are a deliberate demo device

A Claude agent only sees the tools its gateway lists, so on its own it would simply say "I have no tool for that" and never reach the gateway's refusal. To show the *platform* saying no
(not the model), each agent is told the names of other teams' tools and given one fallback tool, `try_other_tool`, with the instruction to **attempt** a request that only another team's tool could serve.
The gateway then really refuses (MCP error `-32602`), and Okta really logs a `DENY`. The agent's own tools are used for everything else. The page says this next to the chat so nobody is misled.
The fallback can only do what the person's own token allows, so it adds no access.

## Why the pieces are the way they are

- **The person's token goes all the way through.** The web app receives the token Okta issues for the team gateway, and the agent forwards the same token. That keeps the gateway's per-person governance (and the audit trail) intact, and means the agent runtime never needs, or can mint, credentials of its own.
- **One AgentCore runtime per team, each locked to its gateway.** The authorizer is pinned to that gateway's own Okta authorization server and audience, so a Sales token cannot even invoke the HR agent.
- **Gateway connections use "brokered consent" (STS).** The Agent Gateway only accepts `STS_ACCESS_TOKEN` connections: the first time a person uses a service they approve it once, Okta stores that consent per Okta user, and from then on Okta exchanges the token for a service token silently. (Cross App Access / ID-JAG exists in Okta but cannot be used behind a gateway today.)
- **Custom authorization servers for CRM and HR.** They let us define our own scopes and a rule per team's group. GitHub is different: its authorization server is GitHub's, reached through a GitHub App.
- **API Gateway, not a Lambda Function URL.** An MCP client discovers which authorization server to use from the `WWW-Authenticate` header of a `401`. Lambda Function URLs rewrite that header; API Gateway passes it through. API Gateway also gives throttling.
- **Okta, not API Gateway, authorizes the MCP servers.** The API has no authorizer on purpose: the Lambda verifies the RS256 signature, `iss`, `aud` and `exp` itself, so the server stays safe even if called directly.
- **The RDS Data API.** The Lambdas run SQL over HTTPS with IAM, so there is no VPC, no connection pool and no database password in code (Aurora keeps the password in Secrets Manager, and the Lambda role may read only that one secret).
- **Aurora Serverless v2 that can pause.** Idle cost is near zero; the price is about 15 seconds on the first call after a pause. The MCP servers retry for up to 24 seconds so that call is slow rather than failed, the chat shows a hint while a tool runs long, and `npm run preflight` wakes the database beforehand.
- **Writes are real.** `update_deal_stage` (needs `crm:write`) is a real tool on the Sales gateway and Sofia's token carries that scope, so her agent *will* change a deal if asked. `npm run preflight` restores the seeded deal stages.

## Everything that gets created

### Okta (by `npm run okta`)

| Object | Names |
|---|---|
| Groups | `Engineering`, `Sales`, `HR` |
| Users (in those groups) | `ethan.park@`, `sofia.reyes@`, `hannah.cho@agentgateway.demo` |
| Custom authorization servers | `CRM MCP` (scopes `crm:read`, `crm:write`; rule `Sales Only`), `HR MCP` (`hr:read`, `hr:sensitive`; rule `HR Only`) |
| MCP server records | `GitHub MCP`, `CRM MCP`, `HR MCP` |
| Credentials (brokered consent) | GitHub App credentials, `Sales STS Client`, `HR STS Client` (each backed by an OIDC app named `<MCP> STS Client`) |
| Gateways | `Engineering Tools` (`/mcp/servers/engineering-tools`), `Sales Tools` (`sales-tools`), `HR Resources` (`hr-resources`); Okta also creates an authorization server `Gateway: <path>` for each, which issues the tokens |
| Tools switched on | Engineering: `get_me`, `search_repositories`, `get_file_contents`. Sales: `search_customers`, `get_customer`, `list_deals`, `update_deal_stage`. HR: `list_employees`, `get_employee`, `get_compensation` |
| Agents (each an OIDC app assigned to one group) | `Engineering Agent`, `Sales Agent`, `HR Agent` |
| Delegation links | one per agent, to its own gateway only |

The names matter: the app, `npm run preflight` and the tool names (`CRMMCP_search_customers`, ...) rely on them. Okta derives the tool prefix from the MCP server's display name.

### AWS: data and MCP servers (`infra/aws/template.yaml`, stack `agw-demo`)

| Resource | Details |
|---|---|
| Aurora PostgreSQL Serverless v2 cluster `demo-db` + one `db.serverless` instance | 0 to 2 ACUs, pauses after an hour idle, Data API on, encrypted, password managed by Secrets Manager |
| Lambda `agw-demo-crm-mcp`, `agw-demo-hr-mcp` | Node.js, arm64, 256 MB, 29 s timeout, settings from environment variables |
| IAM role per Lambda | CloudWatch Logs, `rds-data:ExecuteStatement` on the cluster, `secretsmanager:GetSecretValue` on the cluster's secret, nothing else |
| API Gateway HTTP API `agw-demo-mcp` | Routes `ANY /crm`, `ANY /hr` and the two `/.well-known/oauth-protected-resource/...` paths; throttled to 10 requests/s |
| Log groups | 14 days' retention |

### AWS: the agents (`infra/aws/agents.yaml`, stack `agw-demo-agents`)

| Resource | Details |
|---|---|
| ECR repository `agw-demo-agent` | The one agent image (Strands + Claude); keeps the last 5 images; deleted with the stack |
| IAM role | Pull the image, write logs, invoke Anthropic models through this account's inference profiles; nothing else |
| AgentCore runtimes `agw_demo_engineering`, `agw_demo_sales`, `agw_demo_hr` | Public network, HTTP protocol, a JWT authorizer pinned to that team's gateway issuer and audience, the `Authorization` header allowed through, and `TEAM_NAME`, `TEAM_BRIEF`, `GATEWAY_URL`, `MODEL_ID`, `OTHER_TOOLS` as environment |

### Data

`infra/db/01-schema.sql` and `02-seed.sql`: schema `crm` (8 customers, 10 deals) and schema `hr` (8 employees, compensation). All fictional.

## The agent (`agents/app.py`)

A [Strands](https://strandsagents.com) agent on AgentCore's HTTP contract (`POST /invocations`, `GET /ping`, port 8080, ARM64). On each request it reads the caller's token from the `Authorization` header
(AgentCore has already verified it), opens an MCP session to the team's gateway with that header, lists the tools the gateway exposes, and lets Claude (default: Haiku 5.5) use them. It streams events back:
the tool list, each tool call and result, and the answer text. Conversation memory is kept per AgentCore session in memory. The image is the same for every team; the environment decides which team it is.

## The web app

`server.js` (Express) signs the person in with OAuth 2.0 authorization code and PKCE against the *agent's* Okta app, then, for each chat message, calls the person's AgentCore runtime with that token and streams the answer to the page (`POST /api/chat`).
Each tool event is recorded in the timeline with a plain-language verdict (`verdicts.js`), and when `OKTA_API_TOKEN` is set the app reads Okta's System Log to attach evidence to it.
Each person is a "persona" (`personas.js`) with their own client, gateway URL, runtime and starter prompts. Sessions are in memory and the app is for `localhost` only.
