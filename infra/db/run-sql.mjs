// Runs a .sql file against Aurora through the RDS Data API, one statement at a time, using the AWS CLI you are signed in with.
// Usage: DB_CLUSTER_ARN=... DB_SECRET_ARN=... node infra/db/run-sql.mjs infra/db/01-schema.sql
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const { DB_CLUSTER_ARN, DB_SECRET_ARN, DB_NAME = 'postgres', AWS_REGION = 'us-east-1' } = process.env;
const file = process.argv[2];
if (!DB_CLUSTER_ARN || !DB_SECRET_ARN || !file) { console.error('Set DB_CLUSTER_ARN and DB_SECRET_ARN, and pass a .sql file'); process.exit(1); }

// The Data API runs one statement per call. These files hold no semicolons inside strings, so splitting on them is safe.
const statements = readFileSync(file, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
  .split(';').map((s) => s.trim()).filter(Boolean);

let n = 0;
for (const sql of statements) {
  n++;
  process.stdout.write(`[${n}/${statements.length}] ${sql.replace(/\s+/g, ' ').slice(0, 70)} ... `);
  execFileSync('aws', ['rds-data', 'execute-statement', '--region', AWS_REGION, '--resource-arn', DB_CLUSTER_ARN,
    '--secret-arn', DB_SECRET_ARN, '--database', DB_NAME, '--sql', sql, '--output', 'json'], { stdio: ['ignore', 'pipe', 'inherit'] });
  console.log('ok');
}
console.log(`Done: ${n} statements.`);
