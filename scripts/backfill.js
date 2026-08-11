#!/usr/bin/env node
// scripts/backfill.js
//
// Phase A historic backfill: results and ladders for completed seasons.
// storage_ingestion_design.md §6.1 and §6.1a.
//
// Seasons come from the manifest in data/core.json, not from config.json, so no
// hand-editing is needed to reach a past season. The fetch itself is
// scripts/lib/results-engine.js — the same code the scheduled run exercises
// every weekend. There is deliberately no second copy of it here.
//
// Inputs, all environment variables set by the workflow:
//   BACKFILL_ORG      8-character organisation code, e.g. 383836bb   (required)
//   BACKFILL_SEASON   season name, e.g. 2025, or "all"               (required)
//   BACKFILL_PHASE    A (default). B is not implemented.
//   BACKFILL_DRY_RUN  "true" resolves and reports, then stops before fetching.
//
// PHASE A WRITES DATA ONLY. Nothing changes on screen: index.html only fetches
// an organisation's archive when that organisation has no live season, and all
// five in scope have an ACTIVE 2026 season. The dashboard side is a separate
// piece of work — see §6.1.
//
// Exit codes: 0 = changed, commit. 2 = no change, skip commit. 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');
const engine = require('./lib/results-engine');

const VERSION = 'backfill v1 2026-08-12 (phase A)';
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CORE_PATH = path.join(ROOT, 'data', 'core.json');

function fail(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(1);
}

async function main() {
  console.log(`=== ${VERSION} (engine ${engine.ENGINE_VERSION}) ===`);

  const org = (process.env.BACKFILL_ORG || '').trim();
  const seasonInput = (process.env.BACKFILL_SEASON || '').trim();
  const phase = (process.env.BACKFILL_PHASE || 'A').trim().toUpperCase();
  const dryRun = process.env.BACKFILL_DRY_RUN === 'true';

  if (phase !== 'A') {
    fail(`phase "${phase}" is not implemented. Phase A is results and ladders; ` +
         `Phase B is player statistics and is not built.`);
  }
  if (!/^[0-9a-f]{8}$/i.test(org)) {
    fail(`BACKFILL_ORG must be an 8-character organisation code, got "${org}".`);
  }
  if (!seasonInput) fail('BACKFILL_SEASON is required — a season name such as 2025, or "all".');

  // ── Resolve the seasons from the manifest ──────────────────────────────────
  if (!fs.existsSync(CORE_PATH)) {
    fail('data/core.json not found. Run "Discover seasons" first — the manifest is ' +
         'where this script gets its seasons from.');
  }
  let core;
  try { core = JSON.parse(fs.readFileSync(CORE_PATH, 'utf8')); }
  catch (e) { fail(`could not parse data/core.json: ${e.message}`); }
  if (!Array.isArray(core.manifest) || !core.manifest.length) {
    fail('data/core.json has no manifest. Run "Discover seasons".');
  }

  const forOrg = core.manifest.filter(m => m.org === org);
  if (!forOrg.length) {
    const known = [...new Set(core.manifest.map(m => m.org))].sort();
    fail(`no manifest entries for organisation "${org}". Known: ${known.join(', ')}`);
  }

  const wanted = seasonInput.toLowerCase() === 'all'
    ? forOrg
    : forOrg.filter(m => String(m.seasonName) === seasonInput);
  if (!wanted.length) {
    fail(`organisation ${org} has no season named "${seasonInput}". ` +
         `It has: ${forOrg.map(m => m.seasonName).join(', ')}`);
  }

  // ── Guards. Each refuses rather than producing something wrong ─────────────
  //
  // compName is half of every match id, every roster key and every gradeMeta
  // key. A null one means discover-seasons.js could not prove the short name
  // against existing data, and inventing one here would store records under a
  // key nothing can find. Twelve organisations are in that state.
  const unnamed = wanted.filter(m => !m.compName);
  if (unnamed.length) {
    fail(`${unnamed.length} of ${wanted.length} season(s) have compName: null — ` +
         `${unnamed.map(m => m.seasonName).join(', ')}. Their short name has not been ` +
         `decided, and compName is half of every stored key. Choose the names and ` +
         `migrate config.json first.`);
  }

  // Phase A is for history. A live season is the scheduled run's job, and
  // fetching it here would bypass the season-ended guard for no reason.
  const live = wanted.filter(m => !m.retired);
  if (live.length) {
    fail(`${live.length} of ${wanted.length} season(s) are not retired — ` +
         `${live.map(m => `${m.seasonName} (${m.status})`).join(', ')}. ` +
         `Phase A backfills completed seasons only; the scheduled run owns live ones. ` +
         `Name a specific season rather than "all".`);
  }

  // ── excludeGrades, carried across from config by matching the season id ────
  // excludeGrades shifts grade ranks, so a backfilled season must use the same
  // list the live season does or its gradeMeta ranks will not line up.
  let excludeGrades = [];
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const idsForOrg = new Set(forOrg.map(m => m.seasonId));
      const hit = (cfg.competitions || []).find(c => idsForOrg.has(c.seasonID));
      if (hit) {
        excludeGrades = hit.excludeGrades || [];
        console.log(`excludeGrades from config entry "${hit.name}": ` +
          (excludeGrades.length ? excludeGrades.join(', ') : '(none)'));
      } else {
        console.log(`No config.json competition matches organisation ${org} — excludeGrades empty.`);
      }
    } catch (e) {
      console.warn(`Could not read config.json for excludeGrades: ${e.message} — using none.`);
    }
  }

  const competitions = wanted.map(m => ({
    name: m.compName,          // "EFNL 2025" — the compName, not the short name
    seasonID: m.seasonId,
    excludeGrades,
  }));

  console.log(`\norganisation: ${org} (${wanted[0].orgName || '?'})`);
  console.log(`seasons to backfill: ${wanted.length}`);
  for (const m of wanted) {
    console.log(`  ${m.seasonName}  ${m.seasonId}  ${String(m.compName).padEnd(20)} ` +
      `${m.status}  ends ${m.endDate}  -> ${m.file}`);
  }

  if (dryRun) {
    console.log('\nBACKFILL_DRY_RUN is set — resolved the seasons and stopped before fetching.');
    console.log('Nothing was read from PlayHQ and nothing was written.');
    process.exit(2);
  }

  // ── Fetch ──────────────────────────────────────────────────────────────────
  // The scope is the compNames being backfilled. store.load opens both the
  // organisation's -current and -archive files for that scope, so the live
  // season's records come along and round-trip back to -current untouched, and
  // the retired seasons bucket into -archive. store.save creates the archive if
  // it does not exist, which it will not on the first run.
  const r = await engine.run({
    competitions,
    scope: competitions.map(c => c.name),
    // Every season here has finished by definition, so the guard would skip all
    // of them.
    ignoreSeasonEnded: true,
    // lastRound is keyed age|rawGrade with no season, so writing it would
    // overwrite the live season's value. §3 of the design document gives this as
    // the alternative to re-keying, and the archive has no consumer yet.
    writeLastRound: false,
    label: 'backfill',
  });

  // A backfill is a one-off over immutable data. A grade that failed will not be
  // retried by a scheduled run, so it must be loud rather than a warning buried
  // in a long log.
  if (r.failedGrades.length) {
    console.error(`\nFATAL: ${r.failedGrades.length} grade(s) failed. The seasons written are ` +
      `INCOMPLETE. Re-run this same command — it is idempotent — and if the same grades ` +
      `fail again, investigate before treating the season as backfilled.`);
    process.exit(1);
  }

  console.log(`\n${r.newCount} new, ${r.updatedCount} updated, ${r.total} total in scope`);
  if (r.exitCode === 2) console.log('Nothing changed — skipping commit');
  process.exit(r.exitCode);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
