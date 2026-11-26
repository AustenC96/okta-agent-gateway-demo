# Okta Agent Gateway demo

An interactive demo of **Okta Agent Gateway** with real AI agents: three fictional employees each chat with their own team's Claude-powered agent
(hosted on Amazon Bedrock AgentCore), each agent reaches only its own team's tools through a gateway, using the person's own Okta token, with Okta's System Log as the evidence for every decision.

| Person | Team | Their agent | Their gateway | Tools behind it |
|---|---|---|---|---|
| Ethan Park | Engineering | Engineering Agent | Engineering Tools | GitHub MCP server |
| Sofia Reyes | Sales | Sales Agent | Sales Tools | CRM MCP server (AWS Lambda + Aurora) |
| Hannah Cho | HR | HR Agent | HR Resources | HR MCP server (AWS Lambda + Aurora) |

Pick a person, sign in, and chat with their agent using starter prompts. Then try to break it. Every answer is a plain verdict, with the **stage** that decided it (Okta sign-in, Gateway, Token exchange, MCP server):

| Verdict | Who decided | How to trigger it |
|---|---|---|
| **Allowed** | Okta issued a scoped token and the tool ran | Run any tool the person's team owns |
| **Blocked by Okta** | The sign-in itself was refused | Sign the same person in to *another team's* agent (the chat then shows that agent locked) |
| **Blocked by the gateway** | The tool is not on the gateway's list | Ask the agent for something only another team's tool could do (the page has "Try to break it" prompts) |
| **One-time consent needed** | The person has not yet approved the downstream service | The first tool call of a new user |

It is a local web app (Node + Express) that signs the person in and streams the chat, plus the AWS and Okta pieces it talks to. Nothing is mocked:
the agents, the tokens, the gateways, the MCP servers and the database are real, and the "Under the hood" drawer shows each request and token.

> **Status.** Okta Agent Gateway and its APIs are a Research Release (Beta) and may change. This repo is a demo, not production code.

## Set it up in your own environment

You need an Okta org with Agent Gateway enabled (with a super-admin API token), an AWS account with Claude enabled on Bedrock, Docker, and Node 20+. About an hour, most of it waiting
for the database to be created.

```sh
git clone https://github.com/AustenC96/okta-agent-gateway-demo.git && cd okta-agent-gateway-demo
npm install
cp .env.example .env             # then set OKTA_ORG_URL and OKTA_API_TOKEN

npm run okta -- identity --add-me                       # 1. groups, three fictional users, two custom authorization servers
infra/deploy.sh --crm-issuer <url> --hr-issuer <url>    # 2. AWS: database, two MCP servers, API Gateway (URLs printed by step 1)
npm run okta -- connect --api-url <McpApiUrl>           # 3. MCP servers, gateways, tools, agents (URL printed by step 2)
infra/deploy-agents.sh                                  # 4. the three Claude agents on Bedrock AgentCore (needs step 3)
npm run okta -- env                                     # 5. prints the .env lines for the agents; add the AWS lines steps 2 and 4 printed
npm run preflight                                       # 6. checks everything, wakes the database, starts the app
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
| `infra/deploy-agents.sh` | Builds the agent image and creates the three AgentCore runtimes |
| `npm run okta -- teardown` | Removes the Okta objects the demo created |
| `npm run seed` | Loads the fictional data (`-- --reset` reloads it) |
| `npm run warm` | Wakes the paused database |
| `npm test` | 89 offline tests (no Okta, AWS or network needed) |
| `node scripts/preview.mjs /tmp/preview` | Renders every screen to PNG in headless Chrome against a fake backend |

## Repository map

```
server.js, personas.js, verdicts.js, config.js   the app: sign-in, MCP calls, verdicts, System Log evidence
public/                                          the web page
infra/aws/template.yaml                          CloudFormation: Aurora Serverless v2, two Lambdas, API Gateway
infra/mcp/                                       the two MCP servers (no dependencies); core.mjs verifies tokens and scopes
infra/db/                                        fictional CRM and HR data and its loader
infra/aws/agents.yaml, infra/deploy-agents.sh    CloudFormation + script for the three AgentCore agents
agents/                                          the agent: one Strands + Claude container for all three teams
infra/deploy.sh                                  one command to deploy the data and MCP servers on AWS
scripts/okta-bootstrap.mjs                       creates, checks and removes the Okta objects
scripts/preflight.mjs                            the before-you-present check
test/                                            offline tests
docs/                                            setup, architecture, presenting, troubleshooting
```

## License

[MIT](LICENSE). All people, companies and data in this demo are fictional.
