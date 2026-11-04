'use strict';
// Canonical, JSON-safe representation of any value the code under test
// produces (IPC payloads cross a structured-clone boundary, so undefined,
// NaN, Dates... must survive). Object keys are sorted so that property
// order — which no renderer can observe — never shows up as a difference.

function canon(v, seen = new Set()) {
  if (v === undefined) return '<undefined>';
  if (v === null) return null;
  const t = typeof v;
  if (t === 'number') {
    if (Number.isNaN(v)) return '<NaN>';
    if (!Number.isFinite(v)) return v > 0 ? '<Infinity>' : '<-Infinity>';
    if (Object.is(v, -0)) return 0;
    return v;
  }
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'bigint') return `<bigint:${v}>`;
  if (t === 'function') return '<function>';
  if (t === 'symbol') return `<symbol:${v.description}>`;
  if (seen.has(v)) return '<circular>';
  seen.add(v);
  try {
    if (Array.isArray(v)) {
      const out = [];
      for (let i = 0; i < v.length; i++) out.push(i in v ? canon(v[i], seen) : '<hole>');
      return out;
    }
    if (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]') {
      const n = v.getTime();
      return { $date: Number.isNaN(n) ? 'Invalid Date' : new Date(n).toISOString() };
    }
    if (Buffer.isBuffer(v) || ArrayBuffer.isView(v)) {
      return { $bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
    }
    if (v instanceof ArrayBuffer) return { $bytes: Buffer.from(v).toString('base64') };
    if (v instanceof Map) return { $map: [...v].map(([k, x]) => [canon(k, seen), canon(x, seen)]) };
    if (v instanceof Set) return { $set: [...v].map((x) => canon(x, seen)) };
    if (v instanceof Error) return { $error: String(v.message) };
    if (v instanceof RegExp) return { $regexp: String(v) };
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k], seen);
    return out;
  } finally {
    seen.delete(v);
  }
}

// Replace run-specific substrings (port, temp paths) everywhere in strings.
function normalizeStrings(v, replacers) {
  if (typeof v === 'string') {
    let s = v;
    for (const [from, to] of replacers) {
      if (!from) continue;
      s = s.split(from).join(to);
    }
    return s;
  }
  if (Array.isArray(v)) return v.map((x) => normalizeStrings(x, replacers));
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[normalizeStrings(k, replacers)] = normalizeStrings(v[k], replacers);
    return out;
  }
  return v;
}

// Stable stringify (keys sorted) for already-canonical data.
function stableStringify(v, indent) {
  return JSON.stringify(sortDeep(v), null, indent);
}
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
    return out;
  }
  return v;
}

module.exports = { canon, normalizeStrings, stableStringify, sortDeep };
