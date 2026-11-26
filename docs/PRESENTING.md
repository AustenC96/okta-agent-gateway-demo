# Presenting the demo

A 10-minute talk track. Each person chats with their own team's AI agent. The verdict card on the right answers the last thing that happened in plain words and shows **where** it was decided, so you can narrate over it.

## Before you start (the day, then 5 minutes before)

1. `npm run preflight`. It must end with **READY**. It wakes the database (so there is no 15-second pause on stage), checks the three agents are up, restores the deals, and starts a fresh app so every trace is empty.
2. Open http://localhost:8080 in a fresh browser window. Use a private window if you sign in to Okta as someone else in your normal browser.
3. Have `.okta-demo.json` open somewhere you will not share the screen from: it holds the three people's passwords.
4. Run through each person **once** beforehand, asking one real question each. That gives each person their one-time consent (see below), so it does not interrupt the story.
5. Preflight tells you how long the database stays awake if left idle. If you start later than that, run it again.

## The story (about 10 minutes)

**Setup (1 min).** *"An AI agent should only reach what its user's team is meant to reach. Here are three people, each with their own team's agent, gateway and tools. These are real Claude agents running on AWS Bedrock AgentCore. Okta is the control point between them."* Point at the three cards: Department, Agent, Gateway.

### Act 1: Sofia in Sales, the normal path (3 min)

1. Click **Sofia Reyes**, then **Sign in with Okta**. *"The agent acts as Sofia, not as a shared service account. Her own Okta token goes with every question."*
2. Click **Look up Northwind Logistics**. The agent shows a step row, **Using Search customers**, and then answers in plain language. Expand the step: *"This is the tool Claude picked, with the input it chose and what came back."*
3. Point at the verdict card: **Allowed**, with all four stages green: Okta sign-in, Gateway, Token exchange, MCP server. *"The agent never saw a credential for the CRM. Its token went to the gateway; the gateway asked Okta for a CRM token; Okta checked Sofia and issued one carrying `crm:read`."*
4. Open **Under the hood**. *"The green nodes are confirmed from Okta's own System Log, not from this app's say-so."*

### Act 2: try to break it (3 min)

1. Click **Show me Hannah Cho's salary**. The agent does not refuse on its own: it *tries* `HRMCP_get_compensation`, and the step turns red, **blocked by the gateway**. Verdict **Blocked by the gateway**, stopped at the **Gateway** stage. *"Claude was told other teams' tools exist and to attempt them, so you see the platform say no, not the model. The gateway only knows the tools it was given; and look at the log line: Okta never even tried to get a token for it."* (Okta's own log line appears a few seconds later.)
2. Click **Sign in to the HR Agent**. Okta refuses the sign-in, and the chat switches to a locked **HR Agent**. Verdict **Blocked by Okta**, stopped at **Okta sign-in**. *"Sofia is not in HR, so Okta will not let her use HR's agent. This is group assignment, not something the app decides."* Click **Back to the Sales Agent**.

### Act 3: same pattern, different team (2 min)

Click **Switch persona** → **Hannah Cho (HR)**. Ask **What is Lena Fischer's compensation?**: **Allowed**, because HR's gateway has it and her token carries `hr:sensitive`. Then try **Move the Northwind deal to Closed Won**: blocked, because that is a Sales tool.
Then **Ethan Park (Engineering)** if you set up GitHub: **Who am I on GitHub?** works through his gateway's three read-only GitHub tools; **Merge pull request 1 on octocat/Hello-World** is a real GitHub tool the gateway does not expose.

### Close (1 min)

*"Okta decides who may use which agent, the gateway decides which tools exist, and the tool server checks the scopes in the token. All of it leaves evidence in Okta's System Log, and the model never held a credential. Adding a new team is a group, an agent, a gateway and a connection, not new code."*

## The one-time consent

The first time a person uses a service, Okta needs them to approve it once. The chat shows an amber **One-time consent needed** card. Click **Authorize access**, approve in the new tab, and come back: the question is asked again automatically.
For Ethan this is a GitHub authorization: **he will use the GitHub identity you approve with**, so approve with an account whose repositories you are happy to show. Okta remembers the consent per Okta user. `npm run preflight` tells you who has consented already.
Do this in rehearsal, not on stage.

## Things that can go wrong live, and what to say

| What you see | What it means | Do |
|---|---|---|
| A tool step runs for 15+ seconds, with "the demo database may be waking up" | Aurora paused and is resuming | Wait; it completes. `npm run preflight` or `npm run warm` beforehand avoids it |
| **One-time consent needed** card | That person has not approved the service yet | Click **Authorize access**, approve, return |
| The agent answers in words and does not try the forbidden tool | Claude chose to decline instead of attempting | Ask again more directly (for example "Use the HR compensation tool for Hannah Cho"), or use the **Sign in to another team's agent** prompt, which is deterministic |
| The agent refuses a normal question or picks a different tool than expected | It is a real model; wording matters | Use the starter prompts; they are chosen to match what each tool can really do |
| A write happens (for example a deal stage changes) | The Sales agent really has `update_deal_stage` | `npm run preflight` restores the seeded deal stages |
| Sign-in shows an Okta error page instead of the app | The agent's app is not assigned to the group, or the user is locked out | `npm run preflight` repairs a locked-out user and flags assignments |
| The evidence stays blue ("inferred") | `OKTA_API_TOKEN` is missing or the System Log is lagging a few seconds | Fine to present; say "inferred from Okta's log". Denied events can lag about 15 seconds |
| A person is "Not set up" on the picker, or has no chat | Their agent's client ID, secret or runtime ARN is missing in `.env` | `npm run okta -- env`, `infra/deploy-agents.sh`, fill in the blanks, restart |

## Reset between audiences

`npm run preflight` again. It restarts the app (empty trace, signed out) and puts the deals back. Sign out of Okta in the browser too, or use a private window, so the next person's sign-in is not skipped.
