# Registering this app as a demo.okta component (Level 3)

Draft notes for submitting the app as a **multi-tenant Application** component. Source: *How To: Contribute to Demo.okta*
(Confluence DemoEng, page 643992517) and the platform's Node quickstart. Items marked **Unconfirmed** need an answer from
Demo Engineering before anything is registered.

## Registration form (demo.okta.com/component)
| Field | Value |
| --- | --- |
| Template / type | Custom, **Application** |
| Name | Agent Gateway: Interactive Flow Demo |
| Description | See below |
| Base address | The hosted app's public https address (same value as `BASE_URI`) |
| Multi-tenancy mode | `query` (avoids needing a wildcard domain) |
| All Hooks URL | `<BASE_URI>/hooks` (the quickstart appends `/hooks/<event>`; **Unconfirmed** whether the platform does the same) |
| Platform types | Workforce Identity (the Agent Gateway component is an Okta org feature). **Unconfirmed** |

**Description (draft):** Shows an AI agent reaching GitHub through Okta Agent Gateway, step by step. A live trace shows every
real request and response, and a clickable token-flow diagram shows each token (authorization code, access token, ID token)
and the Okta token exchange that happens on every tool call, with evidence from the Okta System Log. Requires the Agent
Gateway component to be attached to the demo first.

## Taxonomy tags (examples from the guide; the allowed values are not listed there)
- Personas: developer, ciso
- Use cases: zero-trust, logging
- Purpose: demo-utility, enablement
- Industries: none specific

## Documentation link
The Confluence page "Okta Agent Gateway: Interactive Flow Demo (build-on guide)" and the GitHub repository README.

## Settings schema (draft)
No per-demo settings are needed yet. The gateway URL currently has to be supplied by one (see open question 1):

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "gatewayUrl": {
      "type": "string",
      "format": "uri",
      "description": "The Agent Gateway MCP URL for this demo (Deployment Data > gatewayUrl on the Agent Gateway component)"
    }
  },
  "required": ["gatewayUrl"]
}
```

## Open questions for Demo Engineering
1. **Which OIDC client does the hosted app sign in with?** Bootstrap returns the client the platform creates for *this*
   component. The gateway's authorization server only accepts the Agent Gateway component's own agent client, so either that
   client's id and secret must be obtainable (via the webhook's management credentials) with our redirect URI added to it, or
   our client must be added to the gateway's policy. Today `toTenant()` in `bootstrap.js` assumes the first option's inputs
   arrive in Bootstrap and takes the gateway URL from the setting above.
2. **What can the management credentials do?** Which scopes (`okta.apps.manage`, `okta.authorizationServers.*`, workload
   principal APIs)? Needed before `HOOKS_MODIFY_TENANT` can be turned on.
3. **Are webhook calls authenticated?** The docs show no signature or secret. The handlers therefore re-check each demo
   through Bootstrap and only call back to `api.demo.okta.com`.
4. **Acknowledgement and callback contract.** The README of the quickstart says 202 within 3 seconds; the guide says 200.
   Callback timeout, retries and the `execute` payload are undocumented.
5. **Can a component declare that it needs the Agent Gateway component?** Otherwise the `create` handler should check and fail
   with a clear message.
6. **System Log without a personal API token.** The green "Okta token exchange" and "GitHub token" stages need log access;
   hosted, they stay blue (inferred) unless a supported way to read the log exists.
7. **Hosting, ownership and security review** for a service that holds many demos' client secrets. Preferred host: Vercel.
8. **Domains.** The guide says `oktademo.app`; the quickstart landing page says `oktademo.engineering` (dev).

## Known limits of the current code
- With Redis configured, sessions, the trace and System Log evidence are shared across instances. The discovery cache and
  the Bootstrap cache are still per instance (they are only caches and refill on demand).
- Serverless hosting uses polling for the trace (about one request a second while the page is visible).
- Two browser tabs in one browser share one session and trace.
- Not yet deployed anywhere: the Vercel setup has only been exercised locally against stand-ins.
