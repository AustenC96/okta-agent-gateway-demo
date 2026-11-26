# Okta Agent Gateway demo

An interactive demo of **Okta Agent Gateway**: three fictional employees, each using their own team's AI agent, each agent reaching
only their own team's tools through a gateway, with Okta's System Log as the evidence for every decision.

| Person | Team | Their agent | Their gateway | Tools behind it |
|---|---|---|---|---|
| Ethan Park | Engineering | Engineering Agent | Engineering Tools | GitHub MCP server |
| Sofia Reyes | Sales | Sales Agent | Sales Tools | CRM MCP server (AWS Lambda + Aurora) |
| Hannah Cho | HR | HR Agent | HR Resources | HR MCP server (AWS Lambda + Aurora) |

Pick a person, walk the agent through **Discover → Sign in → Connect → Use tools**, then try to break it. Every answer is a plain verdict:

| Verdict | Who decided | How to trigger it |
|---|---|---|
| **Allowed** | Okta issued a scoped token and the tool ran | Run any tool the person's team owns |
| **Blocked by Okta** | The sign-in itself was refused | Sign the same person in to *another team's* agent |
| **Blocked by the gateway** | The tool is not on the gateway's list | Ask for a tool from another team (the page has buttons for this) |
| **One-time consent needed** | The person has not yet approved the downstream service | The first tool call of a new user |

It is a local web app (Node + Express) that plays the agent's part, plus the AWS and Okta pieces it talks to. Nothing is mocked:
the tokens, the gateway, the MCP servers and the database are real, and the "Under the hood" drawer shows each request and token.

> **Status.** Okta Agent Gateway and its APIs are a Research Release (Beta) and may change. This repo is a demo, not production code.

## Set it up in your own environment

You need an Okta org with Agent Gateway enabled (with a super-admin API token), an AWS account, and Node 20+. About 45 minutes, most of it waiting
for the database to be created.

```sh
git clone https://github.com/AustenC96/okta-agent-gateway-demo.git && cd okta-agent-gateway-demo
npm install
cp .env.example .env             # then set OKTA_ORG_URL and OKTA_API_TOKEN

npm run okta -- identity --add-me                       # 1. groups, three fictional users, two custom authorization servers
infra/deploy.sh --crm-issuer <url> --hr-issuer <url>    # 2. AWS: database, two MCP servers, API Gateway (URLs printed by step 1)
npm run okta -- connect --api-url <McpApiUrl>           # 3. MCP servers, gateways, tools, agents (URL printed by step 2)
npm run okta -- env                                     # 4. prints the .env lines for the agents; add the AWS lines step 2 printed
npm run preflight                                       # 5. checks everything, wakes the database, starts the app
```

The full walkthrough, with what each step does, what to expect and the one manual part (the GitHub App for Ethan), is in
**[docs/SETUP.md](docs/SETUP.md)**.

| Document | What it covers |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | Prerequisites and every setup step, with checks after each |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How a request flows, what each layer enforces, every object that gets created |
| [docs/PRESENTING.md](docs/PRESENTING.md) | A 10-minute talk track, what to say, what can go wrong live |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptoms, causes and fixes |
| [SECURITY.md](SECURITY.md) | What is and is not secret here, and how to clean up |

## Commands

| Command | Purpose |
|---|---|
| `npm start` | Run the app at http://localhost:8080 |
| `npm run preflight` | Before a session: checks Okta, AWS and `.env`, wakes the database, resets the deals, restarts the app. `-- --check` changes nothing |
| `npm run okta -- status` | Read-only: lists which Okta objects exist and which are missing |
| `npm run okta -- teardown` | Removes the Okta objects the demo created |
| `npm run seed` | Loads the fictional data (`-- --reset` reloads it) |
| `npm run warm` | Wakes the paused database |
| `npm test` | 83 offline tests (no Okta, AWS or network needed) |
| `node scripts/preview.mjs /tmp/preview` | Renders every screen to PNG in headless Chrome against a fake backend |

## Repository map

```
server.js, personas.js, verdicts.js, config.js   the app: sign-in, MCP calls, verdicts, System Log evidence
public/                                          the web page
infra/aws/template.yaml                          CloudFormation: Aurora Serverless v2, two Lambdas, API Gateway
infra/mcp/                                       the two MCP servers (no dependencies); core.mjs verifies tokens and scopes
infra/db/                                        fictional CRM and HR data and its loader
infra/deploy.sh                                  one command to deploy all of AWS
scripts/okta-bootstrap.mjs                       creates, checks and removes the Okta objects
scripts/preflight.mjs                            the before-you-present check
test/                                            offline tests
docs/                                            setup, architecture, presenting, troubleshooting
```

## License

[MIT](LICENSE). All people, companies and data in this demo are fictional.
