# Presenting the demo

A 10-minute talk track. The page is built so the verdict card on the right answers the last thing you tried, in plain words, so you can narrate over it.

## Before you start (the day, then 5 minutes before)

1. `npm run preflight`. It must end with **READY**. It wakes the database (so there is no 15-second pause on stage), restores the deals, and starts a fresh app so every trace is empty.
2. Open http://localhost:8080 in a fresh browser window. Use a private window if you sign in to Okta as someone else in your normal browser.
3. Have `.okta-demo.json` open somewhere you will not share the screen from: it holds the three people's passwords.
4. Run through each person **once** beforehand. That gives each person their one-time consent (see below), so it does not interrupt the story.
5. Preflight tells you how long the database stays awake if left idle. If you start later than that, run it again.

## The story (about 10 minutes)

**Setup (1 min).** *"An AI agent should only reach what its user's team is meant to reach. Here are three people, each with their own team's agent, gateway and tools. Okta is the control point between them."* Point at the three cards: Department, Agent, Gateway.

### Act 1: Sofia in Sales, the normal path (3 min)

1. Click **Sofia Reyes**. *"The agent starts with one URL and no credentials."* Click **Discover**.
2. **Sign in** → Okta. *"The agent acts as Sofia, not as a shared service account."* Sign in as Sofia. The path strip at the top shows Sofia → Sales Agent → Sales Tools → CRM.
3. **Connect**. The page lists the tools her gateway exposes: four CRM tools and nothing else. *"Notice what is missing: no GitHub tools, no HR tools. The gateway never shows them to her."*
4. Run `search_customers`. Verdict **Allowed**. Open **Under the hood**: *"This is the token flow. The agent's token went to the gateway; the gateway asked Okta for a token for the CRM server; Okta checked Sofia's consent and issued one carrying `crm:read`. The green nodes are confirmed from Okta's own System Log, not from this app's say-so."*

### Act 2: try to break it (3 min)

1. In **Now try to break it → Layer 1 · Okta**, click **Try the HR Agent** (or Engineering Agent). Okta refuses the sign-in. Verdict **Blocked by Okta**. *"Sofia is not in HR, so Okta will not let her use HR's agent. This is group assignment, not something the app decides."*
2. In **Layer 2 · Gateway**, click **get_compensation (HR)**. Verdict **Blocked by the gateway**. *"Even with a valid session, the gateway only knows the tools it was given. This tool does not exist for her. And Okta never even tried to get a token for it: look at the log."* Point at the System Log evidence line.

### Act 3: same pattern, different team (2 min)

Click **Switch persona** → **Hannah Cho (HR)**. Connect and run `get_compensation`: **Allowed**, because HR's gateway has it and her token carries `hr:sensitive`.
Then switch to **Ethan Park (Engineering)** if you set up GitHub: his gateway exposes three read-only GitHub tools and nothing else; the buttons offer `merge_pull_request` (a real GitHub tool the gateway does not expose).

### Close (1 min)

*"Three layers: Okta decides who may use which agent, the gateway decides which tools exist, and the tool server checks the scopes in the token. All of it leaves evidence in Okta's System Log. Adding a new team is a group, an agent, a gateway and a connection, not new code."*

## The one-time consent

The first time a person uses a service, Okta needs them to approve it once. The page then shows **One-time consent needed. Authorize access →**.
Click it, approve, come back and retry. For Ethan this is a GitHub authorization: **he will use the GitHub identity you approve with**, so approve with an account whose repositories you are happy to show. Okta remembers the consent per Okta user. `npm run preflight` tells you who has consented already.
Do this in rehearsal, not on stage.

## Things that can go wrong live, and what to say

| What you see | What it means | Do |
|---|---|---|
| **Waking up** verdict on a Sales or HR call | The database paused and is resuming (about 15 s) | Wait and click again. It is calm by design. `npm run warm` beforehand avoids it. |
| **One-time consent needed** | That person has not approved the service yet | Click the link, approve, retry |
| Sign-in shows an Okta error page instead of the app | The agent's app is not assigned to the group, or the user is locked out | `npm run preflight` repairs a locked-out user and flags assignments |
| The evidence stays blue ("inferred") | `OKTA_API_TOKEN` is missing or the System Log is lagging a few seconds | Fine to present; say "inferred from Okta's log". Denied events can lag about 15 seconds |
| A person is "Not set up" on the picker | Their agent's client ID or secret is missing in `.env` | `npm run okta -- env`, fill in the blanks, restart |

## Reset between audiences

`npm run preflight` again. It restarts the app (empty trace, signed out) and puts the deals back. Sign out of Okta in the browser too, or use a private window, so the next person's sign-in is not skipped.
