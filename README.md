# Okta Agent Gateway: interactive flow demo

A small local web app that walks through an AI agent reaching GitHub **through Okta Agent Gateway**, and shows
every call and token as it happens: a 4-step walkthrough, a live trace of real requests and responses, and a
clickable token-flow diagram (discover, PKCE, auth code, access token, ID token, gateway, Okta token exchange,
GitHub token, tool call).

It builds on the **Agent Gateway** managed component from the demo platform. The component creates the gateway,
the AI agent and the GitHub connection; this app is a front end that plays the agent's role against that gateway.

## Prerequisites

1. A demo org with the Agent Gateway component attached and working. Complete **Parts 1-4** of the
   *Demo Guide: Okta Agent Gateway* (GitHub App, API token, attach, GitHub consent, discover tools).
   You do not need Claude Code (Part 5) for this app.
2. Node.js 20 or newer.

## Setup

### 1. Okta: check the agent app
In the Admin Console open the agent's OIDC app (named like "Agent Gateway Agent") and confirm **Sign-in redirect
URIs** includes `http://localhost:8080/authorization-code/callback`. Add it if it is missing.

### 2. Optional: limit the gateway to read-only tools
The sample inputs only use `get_me`, `search_repositories` and `get_file_contents`. Disabling the other
discovered tools in the gateway's capability list is a good way to also show tool-level governance.

### 3. Configure
```sh
cp .env.example .env
```
Fill in `.env` from the component: `GATEWAY_URL` from **Deployment Data**, `CLIENT_ID` and `CLIENT_SECRET` from the
**Credentials** panel, `OKTA_ORG_URL` from your org (`https://<name>.oktapreview.com` or `https://<name>.okta.com`). Treat the client secret like a password.

Optional: set `OKTA_API_TOKEN` (the token from Part 1 works) so the app can read Okta's System Log and turn the
"Okta token exchange" and "GitHub token" stages green from real evidence. Without it those stages stay blue
("inferred"). Revoke the token when you are done.

### 4. Run
```sh
npm install
npm start
```
Open http://localhost:8080 and follow the steps. Sign in as a user assigned to the agent app (the demo owner is
assigned automatically).

## Three-team version: personas, gateways and real data

The app can also show **who may reach what** across three teams. The home screen is an account chooser (Ethan in Engineering,
Sofia in Sales, Hannah in HR). Each person signs in through **their own team's agent**, which reaches **their own team's gateway**:

| Persona | Agent | Gateway | Behind it |
|---|---|---|---|
| Ethan Park (Engineering) | Engineering Agent | Engineering Tools | GitHub MCP server |
| Sofia Reyes (Sales) | Sales Agent | Sales Tools | CRM MCP server (Aurora) |
| Hannah Cho (HR) | HR Agent | HR Resources | HR MCP server (Aurora) |

After signing in, each page answers the last thing you tried with a plain verdict (**Allowed**, **Blocked by Okta**, **Blocked
by the gateway**, **One-time consent needed**), backed by Okta's own System Log. Two checks try to break it: sign the same
person in to another team's agent (stopped by Okta), and ask for a tool their gateway does not list (stopped by the gateway).

Set these in your shell or `.env` (the original `OKTA_ORG_URL`, `GATEWAY_URL`, `CLIENT_ID` still describe the Engineering persona):
`SALES_AGENT_CLIENT_ID`, `SALES_AGENT_CLIENT_SECRET`, `HR_AGENT_CLIENT_ID`, `HR_AGENT_CLIENT_SECRET`. A persona whose settings are
missing is shown as "not set up". Gateway paths are `sales-tools` and `hr-resources` on the same gateway host (see `personas.js`).

`infra/` holds the two demo MCP servers (`infra/mcp/`, AWS Lambda behind API Gateway, no dependencies) and the fake CRM and HR
data (`infra/db/`, Aurora PostgreSQL through the RDS Data API). Each server verifies the Okta access token and checks its scopes.
Build the Lambda zip with `./infra/build.sh`; load data with `node infra/db/run-sql.mjs infra/db/01-schema.sql`. Aurora can
pause when idle, so run `npm run warm` a few minutes before a session.

To review the interface without signing in to anything: `node scripts/preview.mjs /tmp/preview` renders each state in
headless Chrome against a fake backend and saves screenshots.

## Tests
```sh
npm test
```
Runs without any Okta org or network access: it starts the app on a random port against local stub servers. It covers
trace isolation between visitors, per-demo discovery, redirect URI handling, the System Log user filter, URL safety checks,
the Bootstrap client and the webhook handlers.

## Hosted, multi-tenant mode (work in progress)

The app can also run as a shared service for the demo platform, serving many demos from one deployment. This is **not yet
verified against the real platform**; several details are still being confirmed with Demo Engineering (see
`docs/component-registration.md`). It switches on when the Bootstrap credentials are set:

| Variable | Purpose |
| --- | --- |
| `DEMO_API_APP_ID`, `DEMO_API_CLIENT_ID`, `DEMO_API_CLIENT_SECRET` | The component's Bootstrap credentials from the platform. Turns multi-tenant mode on. |
| `BASE_URI` | The public https address of this deployment. Required in multi-tenant mode. Used as the OAuth redirect URI base; never taken from request headers. |
| `RESOLUTION_STRATEGY` | `query` (default, `?demoName=`) or `subdomain` (`<demo>.<BASE_URI host>`, needs a wildcard domain). |
| `SESSION_SECRET` | Signs session cookies. Set it in any deployment with more than one instance. |
| `TRUST_PROXY` | Number of reverse-proxy hops to trust (for example `1`), so secure cookies work behind a TLS-terminating proxy. |
| `EVENT_TRANSPORT` | `poll` makes the browser fetch the trace with short polls instead of a live stream. Chosen automatically on Vercel. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | A shared Redis (the `KV_REST_API_*` names set by the Vercel marketplace also work). Holds sessions, traces and System Log evidence so several instances can serve one user. Without it, state stays in memory. |
| `CACHE_DURATION` | Minutes to cache a demo's Bootstrap record (default 60). |
| `HOOKS_MODIFY_TENANT` | `true` lets the create/update/delete webhooks change a demo's Okta org. Off by default. |

In this mode each demo's settings come from Bootstrap. Lifecycle webhooks are served at `/hooks/<event>`
(`request`, `attach`, `update`, `detach`, `execute`; `create`, `delete` and `destroy` are accepted as older names).

### Hosting on Vercel (prepared, not yet deployed)
`api/index.js` and `vercel.json` run the whole app as one Vercel function. Requests are stateless there, so a shared Redis
is required and the app refuses to start on Vercel without `UPSTASH_REDIS_REST_URL`/`_TOKEN` and `SESSION_SECRET`. Set these
in the project's environment variables, never in the repository: `SESSION_SECRET`, the Redis pair, `BASE_URI`, and the
`DEMO_API_*` credentials. The live trace switches to polling automatically. Nothing has been deployed yet, so treat this as
untested against Vercel itself.

Without Redis the app keeps everything in memory, so a restart signs everyone out and only one instance can run.

## Notes and limits
- The gateway and Virtual MCP APIs are Research Release (Beta) and may change.
- Narration is generated from the real responses; there is no LLM involved.
- This is a demo: sessions are in memory, there is no TLS, and it should only be run on localhost.
- Never commit `.env`.
