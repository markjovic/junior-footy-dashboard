#!/usr/bin/env node
// scripts/build-career-stubs.js
//
// Creates the player files the career walk works through —
// career_stats_design.md revision 3 §3 and §4.
//
//   players/<first two hex of uuid>/<uuid>.json
//
// One file per person who has ever appeared in one of our competitions, read
// from data/player-index.json (70,672 people at the last count, not the 40,002
// in the current season files — a departed player is exactly who a career view
// is for). A new file is a STUB:
//
//   { "uuid": "…", "name": "…", "statsChecked": null }
//
// `statsChecked: null` is what makes the player due, so
// `fetch-career-stats.js --shard=xx` needs nothing but its own directory. The
// DIRECTORY IS THE COHORT RECORD; there is no separate index for the walk to
// read, which is what keeps each shard job's sparse checkout to its own ~276
// files.
//
// ⚠️ IT ONLY EVER CREATES. An existing file belongs to the walker and is never
// touched here — not to refresh a name, not to reset a timestamp. A builder that
// edited player files would rewrite tens of thousands of them on every run and
// bury the walk's own commits.
//
// ⚠️ IT NEVER DELETES. A person who leaves player-index.json — a season retired,
// a record repaired — still has a career worth keeping. Files with no index row
// are counted and named, and removing them is a deliberate act somebody takes.
//
//   node scripts/build-career-stubs.js            # create missing stubs
//   node scripts/build-career-stubs.js --dry-run  # report, write nothing
//
// Offline: no PlayHQ calls, no session, no store.js. It reads one file and
// writes small ones.
//
// Exit codes: 0 = ran (created or not). 1 = fatal.

'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 'build-career-stubs v1 2026-09-10';

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'data', 'player-index.json');
const PLAYERS = path.join(ROOT, 'players');

const DRY = process.argv.slice(2).includes('--dry-run') || process.env.STUBS_DRY_RUN === 'true';
const log = (...a) => console.log(...a);

function main() {
  log(`=== ${VERSION} ===`);
  log(`Mode: ${DRY ? 'DRY RUN — nothing will be written' : 'building'}`);

  if (!fs.existsSync(INDEX)) {
    console.error(`FATAL: ${path.relative(ROOT, INDEX)} not found. Run Build Player Index first.`);
    process.exit(1);
  }
  let index;
  try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); }
  catch (e) { console.error(`FATAL: could not parse the index — ${e.message}`); process.exit(1); }

  // build-player-index.js v2 writes one row per PERSON:
  //   people: [ [uuid, name, [[seasonIdx, teamIdx, ageIdx, gradeIdx], ...]], ... ]
  const rows = Array.isArray(index.people) ? index.people : null;
  if (!rows || !rows.length) {
    console.error('FATAL: the index has no people[] rows. Nothing to do, and that is not normal.');
    process.exit(1);
  }
  log(`index: ${rows.length} people, ${index.meta && index.meta.personSeasons} person-season(s)`);

  // ⚠️ The shard IS the first two characters of the uuid, and they must be hex —
  // it is a directory name and a matrix key. Anything else is counted and skipped
  // rather than creating a directory the matrix will never visit.
  const counts = new Map();          // shard -> players
  let created = 0, existing = 0, badKey = 0, noName = 0;
  const badSamples = [];
  const seen = new Set();
  let dupes = 0;

  for (const row of rows) {
    const uuid = row && row[0];
    const name = row && row[1];
    if (!uuid || typeof uuid !== 'string') { badKey++; continue; }
    if (seen.has(uuid)) { dupes++; continue; }
    seen.add(uuid);
    const shard = uuid.slice(0, 2).toLowerCase();
    if (!/^[0-9a-f]{2}$/.test(shard)) {
      badKey++;
      if (badSamples.length < 10) badSamples.push(uuid);
      continue;
    }
    if (!name) noName++;

    counts.set(shard, (counts.get(shard) || 0) + 1);
    const dir = path.join(PLAYERS, shard);
    const file = path.join(dir, `${uuid}.json`);
    if (fs.existsSync(file)) { existing++; continue; }
    created++;
    if (DRY) continue;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ uuid, name: name || null, statsChecked: null }));
  }

  // Files with no index row. Counted, named, never removed.
  let orphans = 0;
  const orphanSamples = [];
  if (fs.existsSync(PLAYERS)) {
    for (const shard of fs.readdirSync(PLAYERS)) {
      const dir = path.join(PLAYERS, shard);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const uuid = f.slice(0, -5);
        if (seen.has(uuid)) continue;
        orphans++;
        if (orphanSamples.length < 10) orphanSamples.push(`${shard}/${f}`);
      }
    }
  }

  const per = [...counts.values()].sort((a, b) => a - b);
  const total = per.reduce((a, b) => a + b, 0);

  log(`\n── stubs ──`);
  log(`  people in the index      ${rows.length}`);
  log(`  files already present    ${existing}`);
  log(`  ${DRY ? 'would create' : 'created'}             ${created}`);
  if (dupes) log(`  ⚠️ duplicate uuid rows   ${dupes} — the index should be one row per person`);
  if (badKey) {
    log(`  ⚠️ unusable uuids        ${badKey} — first two characters are not hex, so no shard`);
    for (const u of badSamples) log(`       ${JSON.stringify(u)}`);
  }
  if (noName) log(`  rows with no name        ${noName} (stub written with name null)`);
  log(`  shards in use            ${counts.size} of 256`);
  if (per.length) {
    log(`  players per shard        min ${per[0]}, median ${per[Math.floor(per.length / 2)]}, ` +
        `max ${per[per.length - 1]}, mean ${(total / per.length).toFixed(0)}`);
  }
  // A shard the matrix will visit and find empty is not a fault, but a LOT of
  // them means the uuids are not evenly spread and the fan-out is lopsided.
  const empty = 256 - counts.size;
  if (empty > 8) log(`  ⚠️ ${empty} of 256 shards have no players — the fan-out will be lopsided`);
  if (orphans) {
    log(`  files with no index row  ${orphans} — kept, never deleted; removing one is a deliberate act`);
    for (const o of orphanSamples) log(`       ${o}`);
  }

  if (DRY) { log('\nDRY RUN — nothing written.'); process.exit(0); }
  log(created ? `\nWrote ${created} stub(s) under players/.` : '\nNothing to create — every person already has a file.');
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
