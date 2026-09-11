#!/usr/bin/env node
// scripts/repair-career-held.js
//
// Rewrites the `held` flag on every stored career file from data/core.json.
// Local only — no PlayHQ calls, no session, nothing fetched.
//
//   node scripts/repair-career-held.js            # repair
//   node scripts/repair-career-held.js --dry-run  # report, write nothing
//
// WHY THIS EXISTS. `fetch-career-stats.js` up to v5 set `held` from every
// manifest entry carrying a seasonId. But discover-seasons records seasons for
// all 17 organisations — the five we track AND the twelve we merely watch — so
// the manifest holds 65 season ids while only 18 have data on disk. Measured
// 2026-09-11: 18 competitions came back as "held", among them the VAFA, the
// NFNL and Frankston, none of which this dashboard has ever stored.
//
// The damage is visible rather than theoretical: on the career table a held
// season is rendered bright and made CLICKABLE, so a row for a league we have
// never fetched invited a click that could only fail.
//
// ⚠️ THE FLAG IS DERIVABLE, SO NOTHING IS REFETCHED. A --force sweep would cost
// 70,000 PlayHQ calls to recompute a boolean that core.json already answers.
// This reads one file and rewrites only the players whose flags actually change.
//
// Exit codes: 0 = ran. 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 'repair-career-held v1 2026-09-11';

const ROOT = path.resolve(__dirname, '..');
const PLAYERS = path.join(ROOT, 'players');
const CORE = path.join(ROOT, 'data', 'core.json');
const DRY = process.argv.slice(2).includes('--dry-run') || process.env.REPAIR_DRY_RUN === 'true';

const log = (...a) => console.log(...a);

function main() {
  log(`=== ${VERSION} ===`);
  log(`Mode: ${DRY ? 'DRY RUN — nothing will be written' : 'repairing'}`);

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(CORE, 'utf8')).manifest || []; }
  catch (e) { console.error(`FATAL: could not read data/core.json — ${e.message}`); process.exit(1); }

  // The same filter fetch-career-stats.js v6 and build-player-index.js use: an
  // entry needs BOTH a seasonId and a compName to be a season we store.
  const held = new Set(manifest.filter(m => m.seasonId && m.compName).map(m => m.seasonId));
  const loose = manifest.filter(m => m.seasonId).length;
  log(`manifest: ${manifest.length} entries, ${loose} with a seasonId, ${held.size} that are seasons we store`);
  if (!held.size) { console.error('FATAL: no manifest entry has both a seasonId and a compName.'); process.exit(1); }

  if (!fs.existsSync(PLAYERS)) { console.error('FATAL: players/ does not exist.'); process.exit(1); }

  let files = 0, changed = 0, rowsTrue = 0, rowsFalse = 0, unreadable = 0;
  const leaguesLost = new Map();

  for (const shard of fs.readdirSync(PLAYERS).sort()) {
    const dir = path.join(PLAYERS, shard);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      files++;
      const file = path.join(dir, name);
      let rec;
      try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { unreadable++; continue; }
      if (!rec || !Array.isArray(rec.seasons) || !rec.seasons.length) continue;

      let touched = false;
      for (const s of rec.seasons) {
        const want = !!(s.sid && held.has(s.sid));
        if (!!s.held === want) continue;
        // Only ever narrowing in practice, but counted both ways so a widening
        // would be visible rather than assumed impossible.
        if (want) rowsTrue++; else {
          rowsFalse++;
          const k = s.league || '(no league)';
          leaguesLost.set(k, (leaguesLost.get(k) || 0) + 1);
        }
        s.held = want;
        touched = true;
      }
      if (!touched) continue;
      changed++;
      // ⚠️ `statsChecked` is NOT touched. Bumping it would make every repaired
      // player look freshly walked and push the next real re-check out by 150
      // days. This corrects a derived flag; it does not refresh anything.
      if (!DRY) fs.writeFileSync(file, JSON.stringify(rec));
    }
  }

  log(`\nfiles ${files}${unreadable ? `, UNREADABLE ${unreadable}` : ''}`);
  log(`players ${DRY ? 'that would change' : 'changed'}: ${changed}`);
  log(`rows set to held=false: ${rowsFalse}    rows set to held=true: ${rowsTrue}`);
  if (leaguesLost.size) {
    log(`\nleagues that were wrongly marked as held (rows affected):`);
    for (const [k, n] of [...leaguesLost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      log(`  ${String(n).padStart(7)}  ${k}`);
    }
  }
  if (DRY) log('\nDRY RUN — nothing written.');
  else log(changed ? `\nRewrote ${changed} player file(s).` : '\nNothing needed changing.');
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
