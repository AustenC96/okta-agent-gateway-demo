// A stand-in for an Okta gateway, for testing the agent without Okta: a minimal MCP server (JSON-RPC over HTTP) that logs the
// Authorization header it receives, so you can confirm the agent forwards the caller's token unchanged.   node agents/test/stub-gateway.mjs
import http from 'node:http';
const CUSTOMERS = [
  { customer_id: 'C-1001', name: 'Northwind Logistics', tier: 'Enterprise' },
  { customer_id: 'C-1002', name: 'Contoso Health', tier: 'Enterprise' },
  { customer_id: 'C-1003', name: 'Fabrikam Retail', tier: 'Mid-market' },
];
const TOOLS = [{ name: 'CRMMCP_search_customers', description: 'Search customers by name or tier.', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }];
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const reply = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const rpc = JSON.parse(body || '{}');
    const auth = req.headers.authorization || '';
    console.log(`STUB ${rpc.method} authorization_present=${!!auth} prefix=${JSON.stringify(auth.slice(0, 14))}`);
    if (rpc.id === undefined) { res.writeHead(202); return res.end(); }
    if (rpc.method === 'initialize') return reply({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: rpc.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub-gateway', version: '1' } } });
    if (rpc.method === 'tools/list') return reply({ jsonrpc: '2.0', id: rpc.id, result: { tools: TOOLS } });
    if (rpc.method === 'tools/call') {
      if (!TOOLS.some((x) => x.name === rpc.params?.name)) return reply({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'invalid params' } }); // what the real gateway says
      const q = String(rpc.params?.arguments?.query || '').toLowerCase();
      const hits = CUSTOMERS.filter((c) => `${c.name} ${c.tier}`.toLowerCase().includes(q));
      return reply({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: JSON.stringify(hits) }] } });
    }
    reply({ jsonrpc: '2.0', id: rpc.id, result: {} });
  });
}).listen(9000, '0.0.0.0', () => console.log('stub gateway on :9000'));
