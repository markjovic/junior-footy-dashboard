#!/usr/bin/env node
// scripts/fetch-results.js
//
// The scheduled results run. Reads config.json, filters to VIP competitions when
// VIP_ONLY is set, and hands the work to scripts/lib/results-engine.js.
//
// The fetch itself moved into the engine on 2026-08-12 so that scripts/backfill.js
// could use the same code rather than a second copy of it. Behaviour here is
// unchanged: same competitions, same scope, same exit codes. Three defects were
// fixed in the move and are documented in the engine at the point of each fix —
// the dead catch in fetchGrade, and the lastRound and compLogos maps being
// rebuilt from the scoped run instead of merged over what was stored.
//
// v3 (2026-08-13): engine v14 re-keys lastRound to carry the competition, so the
// writeLastRound argument this script used to pass is gone.
// lastround_gotw_keying_design.md.
//
// Exit codes, unchanged: 0 = changed, commit. 2 = no change, skip commit.
// 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('./lib/results-engine');

const VERSION = 'v3 2026-08-13 lastround-rekey';
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

async function main() {
  console.log(`=== fetch-results ${VERSION} (engine ${engine.ENGINE_VERSION}) ===`);

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('config.json not found at', CONFIG_PATH);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const all = config.competitions || [];
  if (!all.length) {
    console.error('No competitions defined in config.json');
    process.exit(1);
  }

  // VIP_ONLY: only fetch VIP competitions. Set by the workflow for most runs.
  const vipOnly = process.env.VIP_ONLY === 'true';
  const competitions = vipOnly ? all.filter(c => c.vip) : all;
  if (!competitions.length) {
    console.error('VIP_ONLY is set but no competition in config.json has vip: true');
    process.exit(1);
  }
  console.log(`Fetching ${vipOnly ? 'VIP' : 'ALL'} competitions`);

  const r = await engine.run({
    competitions,
    // The scheduled run keeps the season-ended guard. Without it every run
    // re-walks every completed grade of every competition.
    ignoreSeasonEnded: false,
    // writeLastRound was passed here as !vipOnly until engine v14. lastRound was
    // keyed age|rawGrade with no competition, so only a run that saw every
    // competition could compute it and a VIP-only run had to leave it alone. The
    // key now carries the competition and the engine merges per competition, so a
    // VIP-only run writes its own entries and keeps everyone else's. The argument
    // is gone rather than passed as true, because the engine no longer reads it.
    label: 'fetch-results',
  });

  if (r.exitCode === 2) console.log('Skipping commit');
  process.exit(r.exitCode);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
