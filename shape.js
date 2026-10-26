// Temporary diagnostics: describes the structure of a platform payload without its values, so logs can show what the platform
// really sends. Strings, numbers and booleans appear as their type only; keys that look secret are never expanded.
const SECRET = /secret|token|key|pem|jwk|password|credential|assertion/i;

export function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return depth > 5 ? 'array' : `array(${v.length})` + (v.length ? ` of ${JSON.stringify(shape(v[0], depth + 1))}` : '');
  if (typeof v === 'string') return `string(${v.length})`;
  if (typeof v !== 'object') return typeof v;
  if (depth > 5) return 'object';
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET.test(k) ? `[withheld ${typeof x}]` : shape(x, depth + 1);
  return out;
}

// Values of the settings object, which holds the user's choices and is not credentials. Secret-looking keys are withheld.
export function safeValues(o) {
  if (!o || typeof o !== 'object') return o ?? null;
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, SECRET.test(k) ? '[withheld]' : (typeof x === 'string' ? x.slice(0, 200) : shape(x))]));
}
