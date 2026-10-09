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
2. Node.js 18+.

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

## Notes and limits
- The gateway and Virtual MCP APIs are Research Release (Beta) and may change.
- Narration is generated from the real responses; there is no LLM involved.
- This is a demo: sessions are in memory, there is no TLS, and it should only be run on localhost.
- Never commit `.env`.
