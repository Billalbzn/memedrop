// Re-implements bot/index.js handleTts cache logic (lines 53-93) against a mocked upstream
// to count upstream calls for N concurrent identical requests (the /dropall case).
let upstreamCalls = 0;
global.fetch = async () => { upstreamCalls++; await new Promise(r => setTimeout(r, 200)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(30000) }; };
const ttsCache = new Map();
async function handleTts(text) {
  const cacheKey = `fr|${text}`;
  const cached = ttsCache.get(cacheKey);
  if (cached) return 'hit';
  const g = await fetch('x');
  const buf = Buffer.from(await g.arrayBuffer());
  ttsCache.set(cacheKey, buf);
  return 'miss';
}
(async () => {
  const r = await Promise.all(Array.from({ length: 6 }, () => handleTts('salut')));
  console.log('6 concurrent identical requests ->', r.join(','), '| upstream calls =', upstreamCalls);
  // surrogate split check (bot/index.js:589 + :585)
  const t = ('a' + '🔥'.repeat(199)).slice(0, 200);
  try { encodeURIComponent(t); console.log('no throw'); } catch (e) { console.log('encodeURIComponent on sliced tts ->', e.name, e.message); }
  console.log('UTF-16 length of "a"+199 emoji =', ('a' + '🔥'.repeat(199)).length, '| code points =', [...('a' + '🔥'.repeat(199))].length);
})();
