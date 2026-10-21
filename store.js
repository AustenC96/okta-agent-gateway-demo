// State that must outlive a single request: the live trace, Okta System Log evidence, and sessions.
// Two implementations behind one small async interface:
//   memory - for local use and tests (one process, lost on restart)
//   redis  - for serverless hosting, where each request may land on a different instance (Upstash Redis over REST)
import session from 'express-session';

const MAX_EVENTS = 500;
const TRACE_TTL = 3600;     // seconds an idle trace is kept
const EVIDENCE_TTL = 3600;

export function createMemoryStore({ now = Date.now } = {}) {
  const traces = new Map();   // sid -> { events, seq, at }
  const kv = new Map();       // key -> { value, until }
  const sweep = () => {
    for (const [k, v] of kv) if (v.until <= now()) kv.delete(k);
    for (const [k, t] of traces) if (now() - t.at > TRACE_TTL * 1000) traces.delete(k);
  };
  setInterval(sweep, 600e3).unref();
  const trace = (sid) => { let t = traces.get(sid); if (!t) traces.set(sid, t = { events: [], seq: 0, at: now() }); t.at = now(); return t; };
  return {
    kind: 'memory',
    async append(sid, ev) {
      const t = trace(sid); ev.id = ++t.seq; t.events.push(ev); if (t.events.length > MAX_EVENTS) t.events.shift(); return ev;
    },
    async list(sid, after = 0) { return trace(sid).events.filter((e) => e.id > after); },
    async head(sid) { return trace(sid).seq; },
    async clear(sid, { resetSeq = false } = {}) { const t = trace(sid); t.events.length = 0; if (resetSeq) t.seq = 0; },
    async put(key, value, ttl = EVIDENCE_TTL) { kv.set(key, { value: structuredClone(value), until: now() + ttl * 1000 }); },
    async take(key) { const v = kv.get(key); return v && v.until > now() ? structuredClone(v.value) : null; },
    async drop(key) { kv.delete(key); },
    sessionStore() { return new session.MemoryStore(); },
    size: () => ({ traces: traces.size, kv: kv.size }),
  };
}

// `redis` is an @upstash/redis client (or anything with the same get/set/del/incr/expire/zadd/zrange/zremrangebyrank methods).
export function createRedisStore(redis, { prefix = 'agw:' } = {}) {
  const k = (...p) => prefix + p.join(':');
  return {
    kind: 'redis',
    async append(sid, ev) {
      const seqKey = k('seq', sid), evKey = k('ev', sid);
      ev.id = await redis.incr(seqKey);
      await redis.zadd(evKey, { score: ev.id, member: JSON.stringify(ev) });
      await redis.zremrangebyrank(evKey, 0, -(MAX_EVENTS + 1));
      await Promise.all([redis.expire(seqKey, TRACE_TTL), redis.expire(evKey, TRACE_TTL)]);
      return ev;
    },
    async list(sid, after = 0) {
      const rows = await redis.zrange(k('ev', sid), `(${after}`, '+inf', { byScore: true });
      return rows.map((r) => (typeof r === 'string' ? JSON.parse(r) : r));
    },
    async head(sid) { return Number((await redis.get(k('seq', sid))) || 0); },
    async clear(sid, { resetSeq = false } = {}) { await redis.del(k('ev', sid)); if (resetSeq) await redis.del(k('seq', sid)); },
    async put(key, value, ttl = EVIDENCE_TTL) { await redis.set(k('kv', key), JSON.stringify(value), { ex: ttl }); },
    async take(key) { const v = await redis.get(k('kv', key)); return v == null ? null : typeof v === 'string' ? JSON.parse(v) : v; },
    async drop(key) { await redis.del(k('kv', key)); },
    sessionStore: () => new RedisSessionStore(redis, k('sess') + ':'),
  };
}

// express-session store on the same Redis. Sessions expire with the cookie, or after a day if the cookie has no expiry.
export class RedisSessionStore extends session.Store {
  constructor(redis, prefix) { super(); this.redis = redis; this.prefix = prefix; }
  ttl(sess) { const exp = sess?.cookie?.expires ? Math.ceil((new Date(sess.cookie.expires) - Date.now()) / 1000) : 86400; return Math.max(exp, 1); }
  get(sid, cb) { this.redis.get(this.prefix + sid).then((v) => cb(null, v == null ? null : typeof v === 'string' ? JSON.parse(v) : v), cb); }
  set(sid, sess, cb) { this.redis.set(this.prefix + sid, JSON.stringify(sess), { ex: this.ttl(sess) }).then(() => cb?.(), cb); }
  destroy(sid, cb) { this.redis.del(this.prefix + sid).then(() => cb?.(), cb); }
  touch(sid, sess, cb) { this.redis.expire(this.prefix + sid, this.ttl(sess)).then(() => cb?.(), cb); }
}
