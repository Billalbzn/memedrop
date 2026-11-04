'use strict';
// One scenario, one process:  node lib/child.js <app-dir> <scenario> <out.json> <work-root>
// Writes the normalized scenario transcript to <out.json>. Diagnostics go
// to stderr (never into the transcript).

const fs = require('fs');
const path = require('path');

const ORIG_WRITE = fs.writeFileSync;
const ORIG_RM = fs.rmSync;
const REAL_SET_TIMEOUT = setTimeout;
const REAL_CLEAR_TIMEOUT = clearTimeout;

const { Harness } = require('./harness');
const { scenarios } = require('./scenarios');

async function main() {
  const [appDir, name, outFile, workRoot] = process.argv.slice(2);
  const sc = scenarios.find((s) => s.name === name);
  if (!sc) {
    ORIG_WRITE(outFile, JSON.stringify({ fatal: `unknown scenario ${name}` }));
    process.exit(2);
  }
  const workDir = path.join(workRoot, name);
  ORIG_RM(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const h = new Harness({ appDir, workDir, scenario: name });
  const watchdog = REAL_SET_TIMEOUT(() => {
    process.stderr.write(`[${name}] watchdog: scenario did not finish within 120 s\n`);
    try {
      const out = h.serialize();
      out.fatal = 'harness watchdog: scenario did not finish within 120 s';
      out.description = sc.desc;
      ORIG_WRITE(outFile, JSON.stringify(out));
    } catch (e) {
      ORIG_WRITE(outFile, JSON.stringify({ fatal: 'harness watchdog (serialize failed)' }));
    }
    process.exit(3);
  }, 120_000);

  let fatal = null;
  try {
    await h.init();
    await sc.run(h);
    await h.finish();
  } catch (e) {
    fatal = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    process.stderr.write(`[${name}] fatal: ${e && e.stack ? e.stack : e}\n`);
  }
  let out;
  try {
    out = h.serialize();
  } catch (e) {
    process.stderr.write(`[${name}] serialize failed: ${e && e.stack}\n`);
    out = { fatal: `serialize failed: ${e && e.message}` };
  }
  if (fatal) out.fatal = fatal;
  out.description = sc.desc;
  if (sc.edge) out.edge = true;
  ORIG_WRITE(outFile, JSON.stringify(out));
  REAL_CLEAR_TIMEOUT(watchdog);
  h.shutdown();
  try { ORIG_RM(workDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
}

main();
