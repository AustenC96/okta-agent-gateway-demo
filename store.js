// State that must outlive a single request: the live trace, Okta System Log evidence, and sessions.
// Kept in this process's memory, so a restart starts everyone from a clean slate. The small async interface lets another
// backing store be dropped in if it is ever needed.
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
