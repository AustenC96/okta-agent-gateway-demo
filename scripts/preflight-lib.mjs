// The pure half of the pre-flight check: what the demo should look like, and how to judge what was found.
// No network, no AWS, no filesystem beyond what is passed in, so every rule here is covered by tests (test/preflight.test.js).

// For each persona: the MCP server behind its gateway and the tools its gateway should expose, and nothing else.
export const EXPECTED = {
  ethan: { mcp: 'GitHub MCP', prefix: 'GitHubMCP_', tools: ['get_me', 'search_repositories', 'get_file_contents'] },
  sofia: { mcp: 'CRM MCP', prefix: 'CRMMCP_', tools: ['search_customers', 'get_customer', 'list_deals', 'update_deal_stage'] },
  hannah: { mcp: 'HR MCP', prefix: 'HRMCP_', tools: ['list_employees', 'get_employee', 'get_compensation'] },
};

// The seed file is the source of truth for what the fictional data should be.
export function parseSeed(sql) {
  const rows = (table) => [...sql.matchAll(new RegExp(`^INSERT INTO ${table} VALUES \\((.*)\\);\\s*$`, 'gm'))].map((m) => m[1]);
  const deals = rows('crm\\.deals').map((v) => { const f = [...v.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'")); return { id: f[0], stage: f[3] }; });
  return {
    counts: { customers: rows('crm\\.customers').length, deals: deals.length, employees: rows('hr\\.employees').length, compensation: rows('hr\\.compensation').length },
    deals,
  };
}

// Deals are the only data a demo can change (update_deal_stage), so they are the only data that can drift.
export function dealDrift(expected, actual) {
  const now = new Map(actual.map((d) => [d.deal_id ?? d.id, d.stage]));
  return {
    changed: expected.filter((d) => now.has(d.id) && now.get(d.id) !== d.stage).map((d) => ({ id: d.id, from: now.get(d.id), to: d.stage })),
    missing: expected.filter((d) => !now.has(d.id)).map((d) => d.id),
    extra: [...now.keys()].filter((id) => !expected.some((d) => d.id === id)),
  };
}

const same = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

// Judges what was read from Okta against what the demo needs. Each finding is { level: ok|warn|fail, text, fix? };
// a fix is something the script may repair itself (only ever safe, reversible things).
export function evaluateOkta(data, personas) {
  const out = [];
  const add = (level, text, extra = {}) => out.push({ level, text, ...extra });
  for (const p of personas) {
    const want = EXPECTED[p.key];
    const who = p.name;

    const user = data.users.find((u) => u.login?.toLowerCase() === p.login.toLowerCase());
    if (!user) add('fail', `${who}: user ${p.login} does not exist`);
    else if (user.status === 'ACTIVE') add('ok', `${who}: user is active`);
    else if (user.status === 'LOCKED_OUT') add('warn', `${who}: account is locked out`, { fix: { type: 'unlock', id: user.id, name: who } });
    else add('fail', `${who}: account status is ${user.status}, so sign-in will fail`);

    const agent = data.agents.find((a) => a.name === p.agent);
    if (!agent) add('fail', `${p.agent} is missing`);
    else {
      if (agent.status !== 'ACTIVE') add('fail', `${p.agent} is ${agent.status}, not ACTIVE`);
      else if (agent.appStatus && agent.appStatus !== 'ACTIVE') add('fail', `${p.agent}'s sign-in app is ${agent.appStatus}`);
      else add('ok', `${p.agent} is active`);
      if (same(agent.appGroups, [p.department])) add('ok', `${p.agent} is assigned only to ${p.department}`);
      else add('fail', `${p.agent} is assigned to [${agent.appGroups.join(', ') || 'nobody'}] but should be only ${p.department}`);
    }

    const gw = data.gateways.find((g) => g.name === p.gatewayLabel);
    if (!gw) { add('fail', `${p.gatewayLabel} gateway is missing`); continue; }
    add(gw.status === 'ACTIVE' ? 'ok' : 'fail', gw.status === 'ACTIVE' ? `${p.gatewayLabel} gateway is active` : `${p.gatewayLabel} gateway is ${gw.status}, not ACTIVE`);

    const conns = gw.connections;
    const conn = conns.find((c) => c.resource === want.mcp);
    if (conns.length !== 1 || !conn) add('fail', `${p.gatewayLabel} should have exactly one connection (${want.mcp}) but has [${conns.map((c) => c.resource).join(', ') || 'none'}]`);
    else {
      add(conn.status === 'ACTIVE' ? 'ok' : 'fail', conn.status === 'ACTIVE' ? `${p.gatewayLabel} → ${want.mcp} connection is active` : `${p.gatewayLabel} → ${want.mcp} connection is ${conn.status}`);
      const have = conn.tools.map((t) => t.name);
      const should = want.tools.map((t) => want.prefix + t);
      const missing = should.filter((t) => !have.includes(t)), extra = have.filter((t) => !should.includes(t)), bad = conn.tools.filter((t) => t.status !== 'VALID');
      if (!missing.length && !extra.length && !bad.length) add('ok', `${p.gatewayLabel} exposes exactly its ${should.length} tools`);
      else add('fail', `${p.gatewayLabel} tools are wrong${missing.length ? `; missing ${missing.join(', ')}` : ''}${extra.length ? `; unexpected ${extra.join(', ')}` : ''}${bad.length ? `; not valid: ${bad.map((t) => t.name).join(', ')}` : ''}`);
    }

    if (agent) {
      if (same(gw.linkedAgentIds, [agent.id])) add('ok', `${p.gatewayLabel} accepts only the ${p.agent}`);
      else add('fail', `${p.gatewayLabel} delegation links are wrong: it should accept only the ${p.agent}`);
    }
    const mcp = data.mcpServers.find((m) => m.name === want.mcp);
    add(mcp?.status === 'ACTIVE' ? 'ok' : 'fail', mcp ? (mcp.status === 'ACTIVE' ? `${want.mcp} is registered and active` : `${want.mcp} is ${mcp.status}`) : `${want.mcp} is not registered`);
  }
  return out;
}

// Which personas will see a one-time consent link on their first tool call (they have no consent on record).
export function consentReport(personas, latestByLogin) {
  return personas.map((p) => ({ name: p.name, at: latestByLogin.get(p.login.toLowerCase()) || null }));
}

// How long an idle Aurora stays awake, for the closing message.
export function awakeUntil({ minCapacity, autoPauseSeconds }, now = Date.now()) {
  if (minCapacity > 0 || !autoPauseSeconds) return null; // never pauses
  return new Date(now + autoPauseSeconds * 1000);
}
