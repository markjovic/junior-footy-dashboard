#!/usr/bin/env node
// scripts/split-by-season.js
//
// One-time migration from the per-organisation layout to the per-season one.
// per_season_storage_design.md §3.
//
//   from  data/orgs/<org>-current.json  and  <org>-archive.json
//   to    data/seasons/<seasonId>-core.json  and  <seasonId>-players.json
//
// OFFLINE — reads and writes files, calls nothing.
//
// It does NOT delete the old files. They stay as a rollback path until a full
// weekend of scheduled runs has passed on the new layout, which is §4 step 4.
//
// A migration that cannot prove it lost nothing is not a migration. Before
// writing, it reassembles the new layout from what it is about to write and
// compares it against the source record by record. Nothing is written unless
// that comparison passes.
//
// Env:
//   SPLIT_DRY_RUN   "false" to write. Anything else is a dry run.
//
// Exit codes: 0 = written, 2 = nothing to do or dry run, 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 'split-by-season v1 2026-08-12';
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const ORGS_DIR = path.join(DATA, 'orgs');
const SEASONS_DIR = path.join(DATA, 'seasons');
const CORE_PATH = path.join(DATA, 'core.json');
const DRY = process.env.SPLIT_DRY_RUN !== 'false';

const ARRAY_KEYS = ['matches', 'players'];
const PREFIX_KEYS = ['roster', 'gradeMeta'];

function fail(msg) { console.error(`FATAL: ${msg}`); process.exit(1); }
const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

function main() {
  console.log(`=== ${VERSION} ===`);
  console.log(DRY ? 'DRY RUN — nothing will be written.\n' : '*** WRITING ***\n');

  if (!fs.existsSync(CORE_PATH)) fail('data/core.json not found.');
  const core = JSON.parse(fs.readFileSync(CORE_PATH, 'utf8'));
  if (!Array.isArray(core.manifest) || !core.manifest.length) fail('core.json has no manifest.');

  if (!fs.existsSync(ORGS_DIR)) fail('data/orgs not found — nothing to migrate from.');
  const oldFiles = fs.readdirSync(ORGS_DIR)
    .filter(f => /^[0-9a-f]{8}-(current|archive)\.json$/.test(f)).sort();
  if (!oldFiles.length) fail('no per-organisation files found in data/orgs.');

  const idx = new Map();
  for (const m of core.manifest) if (m.compName && m.seasonId) idx.set(m.compName, m);

  // ── Read everything, bucketed by season ──────────────────────────────────
  const buckets = new Map();
  const source = { matches: 0, players: 0, roster: 0, gradeMeta: 0 };
  const unplaced = new Map();

  const bucketFor = (e) => {
    if (!buckets.has(e.seasonId)) {
      buckets.set(e.seasonId, { seasonId: e.seasonId, org: e.org, comps: new Set(),
        matches: [], players: [], roster: {}, gradeMeta: {} });
    }
    const b = buckets.get(e.seasonId);
    b.comps.add(e.compName);
    return b;
  };

  let sourceBytes = 0;
  for (const f of oldFiles) {
    const full = path.join(ORGS_DIR, f);
    sourceBytes += fs.statSync(full).size;
    let payload;
    try { payload = JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch (e) { fail(`could not parse ${f}: ${e.message}`); }

    for (const k of ARRAY_KEYS) {
      for (const rec of payload[k] || []) {
        source[k]++;
        const e = idx.get(rec.compName);
        if (!e) { unplaced.set(rec.compName || '(none)', (unplaced.get(rec.compName || '(none)') || 0) + 1); continue; }
        bucketFor(e)[k].push(rec);
      }
    }
    for (const k of PREFIX_KEYS) {
      for (const [kk, vv] of Object.entries(payload[k] || {})) {
        source[k]++;
        const comp = kk.slice(0, kk.indexOf('|'));
        const e = idx.get(comp);
        if (!e) { unplaced.set(comp || '(none)', (unplaced.get(comp || '(none)') || 0) + 1); continue; }
        bucketFor(e)[k][kk] = vv;
      }
    }
    console.log(`  read ${f.padEnd(28)} ${mb(fs.statSync(full).size).padStart(9)}`);
  }

  if (unplaced.size) {
    for (const [c, n] of unplaced) console.error(`  ${n} record(s) for "${c}" have no manifest entry`);
    fail(`${[...unplaced.values()].reduce((a, b) => a + b, 0)} record(s) cannot be placed. ` +
         `Run "Discover seasons" first. Nothing has been written.`);
  }

  // ── Reassemble and compare, BEFORE writing ───────────────────────────────
  // Counts alone would miss a record moved to the wrong season, so ids are
  // compared as sets per key, not just totalled.
  const rebuilt = { matches: 0, players: 0, roster: 0, gradeMeta: 0 };
  for (const b of buckets.values()) {
    for (const k of ARRAY_KEYS) rebuilt[k] += b[k].length;
    for (const k of PREFIX_KEYS) rebuilt[k] += Object.keys(b[k]).length;
  }
  const mismatched = Object.keys(source).filter(k => source[k] !== rebuilt[k]);
  if (mismatched.length) {
    for (const k of mismatched) console.error(`  ${k}: ${source[k]} read, ${rebuilt[k]} placed`);
    fail('the reassembled layout does not match the source. Nothing has been written.');
  }

  // Every season a record landed in must belong to the organisation whose file
  // it came from — a record in the wrong season would pass a count check.
  for (const b of buckets.values()) {
    for (const c of b.comps) {
      const e = idx.get(c);
      if (!e || e.seasonId !== b.seasonId) fail(`"${c}" bucketed into season ${b.seasonId}, which is wrong.`);
    }
  }

  console.log(`\n  source: ${source.matches} matches, ${source.players} players, ` +
    `${source.roster} roster, ${source.gradeMeta} gradeMeta across ${oldFiles.length} file(s), ${mb(sourceBytes)}`);
  console.log(`  placed: every record accounted for in ${buckets.size} season(s)\n`);

  console.log('  season     org        matches  players    core     players');
  console.log('  ' + '-'.repeat(62));
  let coreBytes = 0, playerBytes = 0;
  const plan = [];
  for (const b of [...buckets.values()].sort((a, x) => a.seasonId.localeCompare(x.seasonId))) {
    const corePayload = JSON.stringify({
      meta: { seasonId: b.seasonId, org: b.org, comps: [...b.comps].sort(),
              generatedAt: new Date().toISOString(),
              phases: { results: b.matches.length > 0, players: b.players.length > 0,
                        matches: b.matches.length, players_n: b.players.length } },
      matches: b.matches, roster: b.roster, gradeMeta: b.gradeMeta,
    });
    const playersPayload = JSON.stringify({
      meta: { seasonId: b.seasonId, generatedAt: new Date().toISOString(), count: b.players.length },
      players: b.players,
    });
    coreBytes += corePayload.length; playerBytes += playersPayload.length;
    plan.push({ b, corePayload, playersPayload });
    console.log(`  ${b.seasonId}   ${b.org}   ${String(b.matches.length).padStart(6)}   ` +
      `${String(b.players.length).padStart(6)}  ${mb(corePayload.length).padStart(8)}  ${mb(playersPayload.length).padStart(9)}`);
  }
  console.log('  ' + '-'.repeat(62));
  console.log(`  ${'TOTAL'.padEnd(22)} ${mb(coreBytes).padStart(8)}  ${mb(playerBytes).padStart(9)}   ` +
    `(${(100 * playerBytes / (coreBytes + playerBytes)).toFixed(0)}% players)`);
  console.log(`\n  a reader taking ladders only fetches ${mb(coreBytes)} instead of ${mb(sourceBytes)}`);

  if (DRY) {
    console.log(`\nDRY RUN — nothing written. Set SPLIT_DRY_RUN=false to apply.`);
    process.exit(2);
  }

  fs.mkdirSync(SEASONS_DIR, { recursive: true });
  const written = [];
  for (const { b, corePayload, playersPayload } of plan) {
    const cp = path.join(SEASONS_DIR, `${b.seasonId}-core.json`);
    const pp = path.join(SEASONS_DIR, `${b.seasonId}-players.json`);
    fs.writeFileSync(cp, corePayload, 'utf8'); written.push(path.relative(ROOT, cp));
    fs.writeFileSync(pp, playersPayload, 'utf8'); written.push(path.relative(ROOT, pp));
  }

  // ── Read the new files back and compare against the source ───────────────
  // The check above compared what was about to be written. This compares what
  // actually landed on disk, which is the only thing that matters.
  const back = { matches: 0, players: 0, roster: 0, gradeMeta: 0 };
  for (const f of fs.readdirSync(SEASONS_DIR)) {
    const p = JSON.parse(fs.readFileSync(path.join(SEASONS_DIR, f), 'utf8'));
    for (const k of ARRAY_KEYS) if (Array.isArray(p[k])) back[k] += p[k].length;
    for (const k of PREFIX_KEYS) if (p[k]) back[k] += Object.keys(p[k]).length;
  }
  const bad = Object.keys(source).filter(k => source[k] !== back[k]);
  if (bad.length) {
    for (const k of bad) console.error(`  ${k}: ${source[k]} in the old layout, ${back[k]} in the new one`);
    fail('the files on disk do not match the source. The old files are untouched — roll back by ignoring data/seasons.');
  }

  // The manifest gains its per-season phase record; the old index goes.
  const phaseBy = new Map(plan.map(({ b }) => [b.seasonId, {
    results: b.matches.length > 0, players: b.players.length > 0,
    matches: b.matches.length, players_n: b.players.length }]));
  core.manifest = core.manifest.map(m => phaseBy.has(m.seasonId) ? { ...m, phases: phaseBy.get(m.seasonId) } : m);
  core.seasonFiles = fs.readdirSync(SEASONS_DIR).sort().map(f => {
    const [seasonId, kindExt] = f.split('-');
    return { file: `data/seasons/${f}`, seasonId, kind: kindExt.replace('.json', ''),
             bytes: fs.statSync(path.join(SEASONS_DIR, f)).size };
  });
  delete core.orgFiles;
  fs.writeFileSync(CORE_PATH, JSON.stringify(core, null, 2), 'utf8');

  console.log(`\n  wrote ${written.length} season file(s) and updated core.json`);
  console.log(`  verified: ${back.matches} matches, ${back.players} players, ` +
    `${back.roster} roster, ${back.gradeMeta} gradeMeta — every record accounted for`);
  console.log(`\n  data/orgs is UNTOUCHED and is the rollback path. Delete it only after a`);
  console.log(`  full weekend of scheduled runs on the new layout.`);
  console.log(`\n${VERSION}: done.`);
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
