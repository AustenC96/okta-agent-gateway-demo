// Loads the fictional CRM and HR data into Aurora, once.   npm run seed          (skips if the data is already there)
//                                                           npm run seed -- --reset  (drops both schemas and loads them again)
// Needs DB_CLUSTER_ARN and DB_SECRET_ARN in the environment (identifiers, not secrets) and a signed-in AWS CLI.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { DB_CLUSTER_ARN, DB_SECRET_ARN, DB_NAME = 'postgres', AWS_REGION = 'us-east-1' } = process.env;
if (!DB_CLUSTER_ARN || !DB_SECRET_ARN) { console.error('Set DB_CLUSTER_ARN and DB_SECRET_ARN first (the stack prints both).'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs one statement. If the database is paused it is resuming: wait and retry (up to about a minute).
async function sql(statement) {
  for (let i = 1; ; i++) {
    try {
      return JSON.parse(execFileSync('aws', ['rds-data', 'execute-statement', '--region', AWS_REGION, '--resource-arn', DB_CLUSTER_ARN, '--secret-arn', DB_SECRET_ARN,
        '--database', DB_NAME, '--sql', statement, '--format-records-as', 'JSON', '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch (e) {
      if (!/resum/i.test(String(e.stderr || e.message)) || i >= 15) throw new Error(String(e.stderr || e.message).trim().split('\n').pop());
      console.log(`  database is waking up... (${i})`); await sleep(4000);
    }
  }
}
const loaded = async () => JSON.parse((await sql("SELECT to_regclass('crm.customers') IS NOT NULL AS loaded")).formattedRecords)[0].loaded;

if (process.argv.includes('--reset')) {
  console.log('Dropping the crm and hr schemas...');
  await sql('DROP SCHEMA IF EXISTS crm CASCADE'); await sql('DROP SCHEMA IF EXISTS hr CASCADE');
} else if (await loaded()) {
  console.log('The CRM and HR data is already loaded: nothing to do (use --reset to load it afresh).'); process.exit(0);
}
for (const f of ['01-schema.sql', '02-seed.sql']) {
  console.log(`Running ${f}`);
  execFileSync(process.execPath, [path.join(here, 'run-sql.mjs'), path.join(here, f)], { stdio: 'inherit', env: process.env });
}
