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
// v4 (2026-09-08): the competitions come from store.fetchTargets(), not from
// config.json's competitions[] — season_rollover_design.md. Under the NEW config
// shape (organisations[] with tracked/vip/excludeGrades and no season ids) the
// manifest decides: tracked organisations' seasons that are active or upcoming,
// or complete for under 7 days — the same rule as the workflow's season gate. A
// 2027 season is fetched the morning discovery records it, with nobody editing
// anything. Under the OLD shape fetchTargets returns competitions[] verbatim and
// nothing here changes. FETCH_INCLUDE_COMPLETE=true (the workflow's
// ignore_season_gate) adds every non-retired complete season.
//
// Exit codes, unchanged: 0 = changed, commit. 2 = no change, skip commit.
// 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('./lib/results-engine');
const store = require('./lib/store');

const VERSION = 'v4 2026-09-08 manifest-targets';
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');

async function main() {
  console.log(`=== fetch-results ${VERSION} (engine ${engine.ENGINE_VERSION}) ===`);

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('config.json not found at', CONFIG_PATH);
    process.exit(1);
  }
  const cfg = store.readConfig();
  const vipOnly = process.env.VIP_ONLY === 'true';
  const includeComplete = process.env.FETCH_INCLUDE_COMPLETE === 'true';
  const all = store.fetchTargets({ includeComplete });
  console.log(`config shape: ${cfg.shape === 'new' ? 'organisations[] — targets from the manifest' : 'competitions[] — targets from config.json'}`);
  if (!all.length) {
    if (cfg.shape === 'old') { console.error('No competitions defined in config.json'); process.exit(1); }
    console.log('No tracked season is active, upcoming or recently complete — nothing to fetch. Skipping commit');
    process.exit(2);
  }
  const competitions = vipOnly ? all.filter(c => c.vip) : all;
  if (!competitions.length) {
    console.error(`VIP_ONLY is set but no ${cfg.shape === 'new' ? 'tracked organisation' : 'competition in config.json'} has vip: true`);
    process.exit(1);
  }
  console.log(`Fetching ${vipOnly ? 'VIP' : 'ALL'} competitions:`);
  for (const c of competitions) console.log(`  ${c.name}  ${c.seasonID}${c.state ? `  state=${c.state}` : ''}${c.excludeGrades.length ? `  excludeGrades=${c.excludeGrades.join(',')}` : ''}`);

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
