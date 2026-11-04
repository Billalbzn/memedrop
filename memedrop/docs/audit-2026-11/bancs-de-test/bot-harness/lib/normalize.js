'use strict';
// Replaces nondeterministic values with stable placeholders while keeping
// equality relations visible:
//   pairing codes   -> <CODE@p1.015#1>   (named after the step where the value
//   drop ids        -> <DROP@p1.031#1>    first appears, so an extra value in
//   random tokens   -> <TOKEN@p4.006#1>   one step does not renumber the rest)
//   HMAC re-link tokens that equal HMAC(LINK_SECRET, <world user id>)
//                   -> <TOKEN hmac(alice)>  (pins the token derivation)
//   epoch-ms numbers near the virtual clock -> "T+<ms>"
// Placeholders are assigned in a fixed walk order (steps in order, keys in
// the canonical order produced by the driver).

function normalize(steps, ctx) {
  const labels = new Map(ctx.fixed || []);
  for (const [raw, lab] of ctx.knownTokens || []) labels.set(raw, lab);
  const perStep = new Map();

  const assign = (kind, raw, stepId) => {
    if (labels.has(raw)) return labels.get(raw);
    const key = `${kind}@${stepId}`;
    const n = (perStep.get(key) || 0) + 1;
    perStep.set(key, n);
    const lab = `<${kind}@${stepId}#${n}>`;
    labels.set(raw, lab);
    return lab;
  };

  const str = (s, stepId) => {
    if (labels.has(s)) return labels.get(s);
    if (ctx.codes.has(s)) return assign('CODE', s, stepId);
    if (ctx.dropIds.has(s)) return assign('DROP', s, stepId);
    if (ctx.tokens.has(s)) return assign('TOKEN', s, stepId);
    let out = s.replace(/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g, (m) => {
      if (labels.has(m)) return labels.get(m);
      return ctx.tokens.has(m) ? assign('TOKEN', m, stepId) : m;
    });
    out = out.replace(/(?<![0-9a-fA-F])[0-9a-fA-F]{16}(?![0-9a-fA-F])/g, (m) => (ctx.dropIds.has(m) ? assign('DROP', m, stepId) : m));
    out = out.replace(/(?<![0-9])[0-9]{6}(?![0-9])/g, (m) => {
      if (labels.has(m)) return labels.get(m);
      return ctx.codes.has(m) ? assign('CODE', m, stepId) : m;
    });
    return out;
  };

  const RANGE = 400 * 86_400_000;
  const num = (n) => (Number.isInteger(n) && Math.abs(n - ctx.epoch) <= RANGE ? `T+${n - ctx.epoch}` : n);

  const walk = (v, stepId) => {
    if (typeof v === 'string') return str(v, stepId);
    if (typeof v === 'number') return num(v);
    if (Array.isArray(v)) return v.map((x) => walk(x, stepId));
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k], stepId);
      return o;
    }
    return v;
  };

  // Step bookkeeping (id, t, t_end) is never close to the epoch, so walking
  // the whole step is safe.
  return steps.map((s) => walk(s, s.id));
}

module.exports = { normalize };
