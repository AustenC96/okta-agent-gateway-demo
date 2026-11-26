import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXPECTED, parseSeed, dealDrift, evaluateOkta, consentReport, awakeUntil } from '../scripts/preflight-lib.mjs';

const PERSONAS = [
  { key: 'ethan', name: 'Ethan Park', department: 'Engineering', login: 'ethan.park@x.test', agent: 'Engineering Agent', gatewayLabel: 'Engineering Tools' },
  { key: 'sofia', name: 'Sofia Reyes', department: 'Sales', login: 'sofia.reyes@x.test', agent: 'Sales Agent', gatewayLabel: 'Sales Tools' },
  { key: 'hannah', name: 'Hannah Cho', department: 'HR', login: 'hannah.cho@x.test', agent: 'HR Agent', gatewayLabel: 'HR Resources' },
];
const tools = (key) => EXPECTED[key].tools.map((t) => ({ name: EXPECTED[key].prefix + t, status: 'VALID' }));
const healthy = () => ({
  users: PERSONAS.map((p, i) => ({ id: `u${i}`, login: p.login, status: 'ACTIVE' })),
  agents: PERSONAS.map((p) => ({ id: `a-${p.key}`, name: p.agent, status: 'ACTIVE', appStatus: 'ACTIVE', appGroups: [p.department] })),
  gateways: PERSONAS.map((p) => ({ name: p.gatewayLabel, status: 'ACTIVE', linkedAgentIds: [`a-${p.key}`], connections: [{ resource: EXPECTED[p.key].mcp, status: 'ACTIVE', tools: tools(p.key) }] })),
  mcpServers: Object.values(EXPECTED).map((e) => ({ name: e.mcp, status: 'ACTIVE' })),
});
const levels = (d) => evaluateOkta(d, PERSONAS);
const fails = (d) => levels(d).filter((f) => f.level === 'fail').map((f) => f.text);

test('a correctly built demo has no problems at all', () => {
  const f = levels(healthy());
  assert.equal(f.filter((x) => x.level !== 'ok').length, 0, JSON.stringify(f.filter((x) => x.level !== 'ok')));
  assert.ok(f.length >= 24);
});

test('a team agent assigned to Everyone, or to a second group, is caught (the Layer 1 guarantee)', () => {
  const d = healthy(); d.agents[1].appGroups = ['Sales', 'Everyone'];
  assert.match(fails(d).join('|'), /Sales Agent is assigned to \[Sales, Everyone\] but should be only Sales/);
  const e = healthy(); e.agents[2].appGroups = [];
  assert.match(fails(e).join('|'), /HR Agent is assigned to \[nobody\]/);
});

test('an inactive agent, app, gateway, connection or MCP server is each reported by name', () => {
  const a = healthy(); a.agents[0].status = 'INACTIVE'; assert.match(fails(a).join('|'), /Engineering Agent is INACTIVE/);
  const b = healthy(); b.agents[1].appStatus = 'INACTIVE'; assert.match(fails(b).join('|'), /Sales Agent's sign-in app is INACTIVE/);
  const c = healthy(); c.gateways[2].status = 'INACTIVE'; assert.match(fails(c).join('|'), /HR Resources gateway is INACTIVE/);
  const d = healthy(); d.gateways[1].connections[0].status = 'INACTIVE'; assert.match(fails(d).join('|'), /Sales Tools → CRM MCP connection is INACTIVE/);
  const e = healthy(); e.mcpServers[0].status = 'INACTIVE'; assert.match(fails(e).join('|'), /GitHub MCP is INACTIVE/);
});

test('a gateway with a missing, extra or invalid tool is caught (the Layer 2 guarantee)', () => {
  const miss = healthy(); miss.gateways[1].connections[0].tools.pop();
  assert.match(fails(miss).join('|'), /Sales Tools tools are wrong; missing CRMMCP_update_deal_stage/);
  const extra = healthy(); extra.gateways[2].connections[0].tools.push({ name: 'HRMCP_delete_everything', status: 'VALID' });
  assert.match(fails(extra).join('|'), /HR Resources tools are wrong; unexpected HRMCP_delete_everything/);
  const bad = healthy(); bad.gateways[0].connections[0].tools[0].status = 'INVALID';
  assert.match(fails(bad).join('|'), /not valid: GitHubMCP_get_file_contents|not valid: GitHubMCP_get_me/);
});

test('a gateway that also reaches another team’s server, or accepts another agent, is caught', () => {
  const two = healthy(); two.gateways[1].connections.push({ resource: 'HR MCP', status: 'ACTIVE', tools: tools('hannah') });
  assert.match(fails(two).join('|'), /Sales Tools should have exactly one connection \(CRM MCP\)/);
  const link = healthy(); link.gateways[0].linkedAgentIds = ['a-ethan', 'a-sofia'];
  assert.match(fails(link).join('|'), /Engineering Tools delegation links are wrong/);
});

test('missing or broken users and objects fail clearly, and a locked account offers the safe fix', () => {
  const gone = healthy(); gone.users.splice(1, 1); assert.match(fails(gone).join('|'), /user sofia.reyes@x.test does not exist/);
  const locked = healthy(); locked.users[2].status = 'LOCKED_OUT';
  const f = levels(locked).find((x) => /locked out/.test(x.text));
  assert.equal(f.level, 'warn'); assert.deepEqual(f.fix, { type: 'unlock', id: 'u2', name: 'Hannah Cho' });
  const susp = healthy(); susp.users[0].status = 'SUSPENDED'; assert.match(fails(susp).join('|'), /status is SUSPENDED/);
  const noGw = healthy(); noGw.gateways.splice(0, 1); assert.match(fails(noGw).join('|'), /Engineering Tools gateway is missing/);
  const noAgent = healthy(); noAgent.agents.splice(2, 1); assert.match(fails(noAgent).join('|'), /HR Agent is missing/);
  const noMcp = healthy(); noMcp.mcpServers.pop(); assert.match(fails(noMcp).join('|'), /HR MCP is not registered/);
});

test('the seed file is parsed into row counts and deal stages that match the real file', () => {
  const s = parseSeed(readFileSync(new URL('../infra/db/02-seed.sql', import.meta.url), 'utf8'));
  assert.deepEqual(s.counts, { customers: 8, deals: 10, employees: 8, compensation: 8 });
  assert.equal(s.deals.length, 10);
  assert.deepEqual(s.deals.find((d) => d.id === 'D-5003'), { id: 'D-5003', stage: 'Closed won' });
  // apostrophes inside values (SQL doubles them) are read back correctly
  const t = parseSeed("INSERT INTO crm.deals VALUES ('D-1', 'C-1', 'Bob''s deal', 'Proposal', 5, 'Sofia');\n");
  assert.deepEqual(t.deals, [{ id: 'D-1', stage: 'Proposal' }]);
});

test('deal drift names what a rehearsal changed, and what is missing or extra', () => {
  const want = [{ id: 'D-1', stage: 'Proposal' }, { id: 'D-2', stage: 'Discovery' }];
  assert.deepEqual(dealDrift(want, [{ deal_id: 'D-1', stage: 'Proposal' }, { deal_id: 'D-2', stage: 'Discovery' }]), { changed: [], missing: [], extra: [] });
  assert.deepEqual(dealDrift(want, [{ deal_id: 'D-1', stage: 'Closed won' }, { deal_id: 'D-2', stage: 'Discovery' }]).changed, [{ id: 'D-1', from: 'Closed won', to: 'Proposal' }]);
  const m = dealDrift(want, [{ deal_id: 'D-1', stage: 'Proposal' }, { deal_id: 'D-9', stage: 'x' }]);
  assert.deepEqual([m.missing, m.extra], [['D-2'], ['D-9']]);
});

test('consent is reported per person, case-insensitively, and absence is visible', () => {
  const r = consentReport(PERSONAS, new Map([['ethan.park@x.test', '2026-11-24T13:07:00Z'], ['sofia.reyes@x.test', '2026-11-24T14:03:00Z']]));
  assert.deepEqual(r.map((x) => [x.name, !!x.at]), [['Ethan Park', true], ['Sofia Reyes', true], ['Hannah Cho', false]]);
});

test('the awake-until time is only given when the database really can pause', () => {
  const now = Date.UTC(2026, 10, 25, 9, 0, 0);
  assert.equal(awakeUntil({ minCapacity: 0, autoPauseSeconds: 3600 }, now).toISOString(), '2026-11-25T10:00:00.000Z');
  assert.equal(awakeUntil({ minCapacity: 0.5, autoPauseSeconds: 3600 }, now), null);
  assert.equal(awakeUntil({ minCapacity: 0, autoPauseSeconds: 0 }, now), null);
});
