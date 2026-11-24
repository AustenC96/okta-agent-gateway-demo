// One plain-language verdict per action, so the page can show "Allowed" or "Blocked by ..." without guessing from raw responses.
// kind: allowed | consent | waking | blocked-okta | blocked-gateway | blocked-server | problem
export const friendlyTool = (name) => {
  const s = String(name || '').replace(/^[A-Za-z0-9]*MCP_/, '').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
};

const textOf = (parsed) => (parsed?.result?.content || []).map((c) => c.text).filter(Boolean).join(' ');

// A tool call that went through the persona's own gateway.
export function callVerdict({ name, status, error, parsed, consentUrl }) {
  if (error || status !== 200) return { kind: 'problem', title: 'The call failed', detail: error || `The gateway answered HTTP ${status}.`, tool: name };
  if (consentUrl) return { kind: 'consent', title: 'One-time consent needed', detail: 'Okta must ask this user to approve access to the service once.', url: consentUrl, tool: name };
  if (parsed?.error) return { kind: 'problem', title: 'The gateway returned an error', detail: String(parsed.error.message || ''), tool: name };
  if (parsed?.result?.isError) {
    const t = textOf(parsed);
    // The MCP servers answer a missing scope with a "Forbidden: ..." result.
    if (/^Forbidden/i.test(t)) return { kind: 'blocked-server', title: 'Blocked by the MCP server', detail: t, tool: name };
    // Not a failure of access: the demo database was asleep. The call got all the way there, so the same call will work in a moment.
    if (/waking up from a pause/i.test(t)) return { kind: 'waking', title: 'The database is waking up', detail: 'It pauses when idle. Run the tool again in about 15 seconds.', tool: name };
    return { kind: 'problem', title: `${friendlyTool(name)} returned an error`, detail: t.slice(0, 200), tool: name };
  }
  return { kind: 'allowed', title: 'Allowed', detail: `${friendlyTool(name)} ran through the gateway.`, tool: name };
}

// Asking the gateway for a tool its admin did not expose.
export function blockedVerdict({ name, gatewayLabel, refused }) {
  return refused
    ? { kind: 'blocked-gateway', title: 'Blocked by the gateway', detail: `${friendlyTool(name)} is not one of the tools ${gatewayLabel || 'this gateway'} exposes.`, tool: name }
    : { kind: 'problem', title: 'Not blocked', detail: `The gateway did not refuse ${friendlyTool(name)}. Check what is exposed on the gateway.`, tool: name };
}

// Okta's answer when a person tries another team's agent.
// target names the chain that was attempted (its agent, gateway and the data behind it) so the page can show the attempt.
export function probeVerdict({ person, agent, refused, target }) {
  return refused
    ? { kind: 'blocked-okta', title: 'Blocked by Okta', detail: `${person} is not assigned to the ${agent}.`, target }
    : { kind: 'problem', title: 'Not blocked', detail: `Okta let ${person} sign in to the ${agent}. Check who the agent’s app is assigned to.` };
}
