// HR MCP server: the employee directory and, separately, pay. The directory needs hr:read; compensation needs hr:sensitive.
import { createMcpHandler, lambdaEntry } from './core.mjs';

export const TOOLS = [
  { name: 'list_employees', scope: 'hr:read', readOnly: true, description: 'List employees in the directory, optionally for one department.',
    inputSchema: { type: 'object', properties: { department: { type: 'string', description: 'For example Engineering, Sales, HR or Finance' } } },
    run: (a, db) => db('SELECT employee_id, name, department, title, location, manager, email FROM hr.employees WHERE (CAST(:dept AS text) IS NULL OR department = :dept) ORDER BY employee_id', { dept: a.department }) },
  { name: 'get_employee', scope: 'hr:read', readOnly: true, description: 'Get one employee from the directory by ID, for example E-2001.',
    inputSchema: { type: 'object', properties: { employee_id: { type: 'string' } }, required: ['employee_id'] },
    run: (a, db) => db('SELECT employee_id, name, department, title, location, manager, email FROM hr.employees WHERE employee_id = :id', { id: a.employee_id }) },
  { name: 'get_compensation', scope: 'hr:sensitive', readOnly: true, description: 'Get one employee\'s salary. Sensitive data.',
    inputSchema: { type: 'object', properties: { employee_id: { type: 'string' } }, required: ['employee_id'] },
    run: (a, db) => db('SELECT e.employee_id, e.name, e.department, c.salary_usd FROM hr.compensation c JOIN hr.employees e USING (employee_id) WHERE e.employee_id = :id', { id: a.employee_id }) },
];

export const createHandler = (opts) => createMcpHandler({ serverName: 'agw-demo-hr', tools: TOOLS, ...opts });
export const handler = lambdaEntry('agw-demo-hr', TOOLS);
