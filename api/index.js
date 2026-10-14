// Vercel entry point. Every request is rewritten to this one function (see vercel.json), which serves the whole Express app.
// Requires: SESSION_SECRET, UPSTASH_REDIS_REST_URL/TOKEN (or the KV_REST_API_* names the Vercel marketplace sets), BASE_URI,
// and the DEMO_API_* Bootstrap credentials. State lives in Redis because each request may run on a different instance.
import { waitUntil } from '@vercel/functions';
import { Redis } from '@upstash/redis';
import { createApp } from '../server.js';
import { configFromEnv } from '../config.js';

const config = configFromEnv(process.env, { redisFactory: (o) => new Redis(o), defer: (p) => waitUntil(p.catch(() => {})) });
export default createApp(config);
