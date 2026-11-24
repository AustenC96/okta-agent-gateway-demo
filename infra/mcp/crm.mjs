// CRM MCP server: customers and deals. Reads need crm:read, changing a deal needs crm:write.
import { createMcpHandler, lambdaEntry } from './core.mjs';

const STAGES = ['Discovery', 'Proposal', 'Negotiation', 'Closed won', 'Closed lost'];
export const TOOLS = [
  { name: 'search_customers', scope: 'crm:read', readOnly: true, description: 'Search customers by name or industry.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Text to look for in the customer name or industry' } }, required: ['query'] },
    run: (a, db) => db('SELECT customer_id, name, industry, tier, contact_name, contact_email, account_owner FROM crm.customers WHERE name ILIKE :q OR industry ILIKE :q ORDER BY name LIMIT 20', { q: `%${a.query}%` }) },
  { name: 'get_customer', scope: 'crm:read', readOnly: true, description: 'Get one customer by ID, for example C-1001.',
    inputSchema: { type: 'object', properties: { customer_id: { type: 'string' } }, required: ['customer_id'] },
    run: (a, db) => db('SELECT customer_id, name, industry, tier, contact_name, contact_email, account_owner FROM crm.customers WHERE customer_id = :id', { id: a.customer_id }) },
  { name: 'list_deals', scope: 'crm:read', readOnly: true, description: 'List deals, optionally for one customer and/or one stage.',
    inputSchema: { type: 'object', properties: { customer_id: { type: 'string' }, stage: { type: 'string', enum: STAGES } } },
    run: (a, db) => db('SELECT deal_id, customer_id, title, stage, amount_usd, owner FROM crm.deals WHERE (CAST(:cid AS text) IS NULL OR customer_id = :cid) AND (CAST(:stage AS text) IS NULL OR stage = :stage) ORDER BY deal_id', { cid: a.customer_id, stage: a.stage }) },
  { name: 'update_deal_stage', scope: 'crm:write', readOnly: false, description: 'Move a deal to a new stage. Changes data.',
    inputSchema: { type: 'object', properties: { deal_id: { type: 'string' }, stage: { type: 'string', enum: STAGES } }, required: ['deal_id', 'stage'] },
    run: async (a, db) => {
      if (!STAGES.includes(a.stage)) throw new Error(`stage must be one of: ${STAGES.join(', ')}`);
      return db('UPDATE crm.deals SET stage = :stage WHERE deal_id = :id RETURNING deal_id, customer_id, title, stage, amount_usd', { stage: a.stage, id: a.deal_id });
    } },
];

export const createHandler = (opts) => createMcpHandler({ serverName: 'agw-demo-crm', tools: TOOLS, ...opts });
export const handler = lambdaEntry('agw-demo-crm', TOOLS);
