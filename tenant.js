// Works out which demo (tenant) a request is for. Pure, so it can be tested without a server.
// strategy: 'none' (single tenant), 'query' (?demoName=), or 'subdomain' (<demo>.<baseHost>).
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;

// Returns { name } (null when the request does not say), or { invalid: true } when it names something that is not a safe demo name.
export function tenantNameFrom(req, { strategy = 'none', baseHost } = {}) {
  let raw = null;
  if (strategy === 'query') {
    raw = req.query?.demoName;
    if (Array.isArray(raw)) return { invalid: true };
  } else if (strategy === 'subdomain' && baseHost) {
    const host = String(req.headers?.host || '').split(':')[0].toLowerCase();
    const base = baseHost.toLowerCase();
    if (host === base) return { name: null };
    if (!host.endsWith('.' + base)) return { invalid: true };
    raw = host.slice(0, -(base.length + 1));
  }
  if (raw == null || raw === '') return { name: null };
  return NAME_RE.test(raw) ? { name: String(raw).toLowerCase() } : { invalid: true };
}
