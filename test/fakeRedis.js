// A small in-memory stand-in for the parts of @upstash/redis that store.js uses, including its JSON auto-parsing quirk.
export function fakeRedis() {
  const strs = new Map(), zs = new Map(), exp = new Map();
  const live = (key) => { const e = exp.get(key); if (e && e <= Date.now()) { strs.delete(key); zs.delete(key); exp.delete(key); } };
  return {
    calls: [],
    async get(key) { live(key); return strs.has(key) ? strs.get(key) : null; },
    async set(key, v, o = {}) { strs.set(key, v); if (o.ex) exp.set(key, Date.now() + o.ex * 1000); return 'OK'; },
    async del(...keys) { let n = 0; for (const key of keys) { n += strs.delete(key) + zs.delete(key); exp.delete(key); } return n; },
    async incr(key) { live(key); const n = Number(strs.get(key) || 0) + 1; strs.set(key, String(n)); return n; },
    async expire(key, s) { exp.set(key, Date.now() + s * 1000); return 1; },
    async zadd(key, { score, member }) { const z = zs.get(key) || []; z.push({ score, member }); z.sort((a, b) => a.score - b.score); zs.set(key, z); return 1; },
    async zremrangebyrank(key, a, b) { const z = zs.get(key) || []; const n = z.length; const lo = a < 0 ? n + a : a, hi = b < 0 ? n + b : b; zs.set(key, z.filter((_, i) => i < lo || i > hi)); return 0; },
    async zrange(key, min, max, o = {}) {
      live(key); if (!o.byScore) throw new Error('fake supports byScore only');
      const lo = String(min).startsWith('(') ? Number(String(min).slice(1)) : Number(min), excl = String(min).startsWith('(');
      return (zs.get(key) || []).filter((e) => (excl ? e.score > lo : e.score >= lo) && (max === '+inf' || e.score <= Number(max))).map((e) => e.member);
    },
  };
}
