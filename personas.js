// The three demo personas. Each one signs in through its own team's Okta agent and reaches its own team's gateway.
// Only non-secret facts live here. The agent client IDs and secrets come from environment variables, and a persona whose
// settings are missing is shown as "not set up" instead of failing.
//
// blockedTools are real tools that exist behind OTHER teams' gateways (or upstream but are not exposed). The governance check
// asks this persona's gateway for one of them, to show the gateway refusing a tool that is not on its list.
export const PERSONA_ORDER = ['ethan', 'sofia', 'hannah'];

export function personasFromEnv(env) {
  const gw = env.GATEWAY_URL ? new URL(env.GATEWAY_URL) : null;
  const gwAt = (path) => (gw ? `${gw.origin}/mcp/servers/${path}` : null);
  // A client whose ID is a URL is a Client ID Metadata Document client: public, so it has no secret and uses /callback.
  const engPublic = /^https:\/\//.test(env.CLIENT_ID || '');
  const defs = [
    {
      key: 'ethan', name: 'Ethan Park', department: 'Engineering', login: 'ethan.park@agentgateway.demo',
      agent: 'Engineering Agent', gatewayLabel: 'Engineering Tools', resourceLabel: 'GitHub',
      gatewayUrl: env.GATEWAY_URL, clientId: env.CLIENT_ID, clientSecret: engPublic ? undefined : env.CLIENT_SECRET,
      callbackPath: env.CALLBACK_PATH || (engPublic ? '/callback' : '/authorization-code/callback'),
      blockedTools: [
        { name: 'GitHubMCP_merge_pull_request', label: 'merge_pull_request (GitHub write)' },
        { name: 'GitHubMCP_delete_file', label: 'delete_file (GitHub write)' },
        { name: 'CRMMCP_list_deals', label: 'list_deals (Sales CRM)' },
        { name: 'HRMCP_get_compensation', label: 'get_compensation (HR)' },
      ],
    },
    {
      key: 'sofia', name: 'Sofia Reyes', department: 'Sales', login: 'sofia.reyes@agentgateway.demo',
      agent: 'Sales Agent', gatewayLabel: 'Sales Tools', resourceLabel: 'CRM data',
      gatewayUrl: gwAt('sales-tools'), clientId: env.SALES_AGENT_CLIENT_ID, clientSecret: env.SALES_AGENT_CLIENT_SECRET,
      callbackPath: '/authorization-code/callback',
      blockedTools: [
        { name: 'HRMCP_get_compensation', label: 'get_compensation (HR)' },
        { name: 'GitHubMCP_get_me', label: 'get_me (GitHub)' },
      ],
    },
    {
      key: 'hannah', name: 'Hannah Cho', department: 'HR', login: 'hannah.cho@agentgateway.demo',
      agent: 'HR Agent', gatewayLabel: 'HR Resources', resourceLabel: 'HR data',
      gatewayUrl: gwAt('hr-resources'), clientId: env.HR_AGENT_CLIENT_ID, clientSecret: env.HR_AGENT_CLIENT_SECRET,
      callbackPath: '/authorization-code/callback',
      blockedTools: [
        { name: 'CRMMCP_update_deal_stage', label: 'update_deal_stage (Sales CRM write)' },
        { name: 'GitHubMCP_get_me', label: 'get_me (GitHub)' },
      ],
    },
  ];
  return defs.map((p) => ({ ...p, configured: !!(p.gatewayUrl && p.clientId && (p.clientSecret || /^https:\/\//.test(p.clientId))) }));
}

// What the browser may know about a persona: everything except the client secret.
export function publicPersona(p) {
  const u = p.gatewayUrl ? new URL(p.gatewayUrl) : null;
  return {
    key: p.key, name: p.name, department: p.department, login: p.login, agent: p.agent, gatewayLabel: p.gatewayLabel, resourceLabel: p.resourceLabel,
    gatewayPath: u ? u.pathname : null, configured: p.configured, blockedTools: p.blockedTools,
  };
}
