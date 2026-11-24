// Wakes the demo database before a session. Aurora pauses after an hour idle and takes about 15 seconds to resume,
// so run this a couple of minutes before showing anyone the demo:   npm run warm
// Needs DB_CLUSTER_ARN and DB_SECRET_ARN in your environment (they are identifiers, not secrets) and a signed-in AWS CLI.
import { execFileSync } from 'node:child_process';
const { DB_CLUSTER_ARN, DB_SECRET_ARN, DB_NAME = 'postgres', AWS_REGION = 'us-east-1' } = process.env;
if (!DB_CLUSTER_ARN || !DB_SECRET_ARN) { console.error('Set DB_CLUSTER_ARN and DB_SECRET_ARN first (see README).'); process.exit(1); }
const started = Date.now();
for (let i = 1; i <= 15; i++) {
  try {
    execFileSync('aws', ['rds-data', 'execute-statement', '--region', AWS_REGION, '--resource-arn', DB_CLUSTER_ARN, '--secret-arn', DB_SECRET_ARN, '--database', DB_NAME, '--sql', 'SELECT 1', '--output', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`Database is awake (${Math.round((Date.now() - started) / 1000)}s).`); process.exit(0);
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (!/resum/i.test(msg)) { console.error(msg.trim()); process.exit(1); }
    console.log(`Waking up… (attempt ${i})`); await new Promise((r) => setTimeout(r, 4000));
  }
}
console.error('Still asleep after a minute. Try again.'); process.exit(1);
