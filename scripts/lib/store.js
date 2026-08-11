// scripts/lib/store.js
//
// The per-organisation storage layer. Every writer goes through this instead of
// reading and writing data/data.json directly.
//
//   const store = require('./lib/store');
//   const data = store.load(compNames);   // same shape data.json had
//   ... unchanged writer logic ...
//   store.save(data, compNames);          // distributed back by organisation
//
// WHY IT LOOKS LIKE THE OLD SHAPE
// load() returns { matches, players, roster, gradeMeta, teamLogos, ... } exactly
// as data.json did, so the writers' logic does not change at all. Only where the
// bytes live changes. A rewrite of four writers in the same commit as a layout
// change would make any regression impossible to attribute.
//
// WHY SCOPING MATTERS
// save(data, scope) rewrites ONLY the organisation files covered by scope. A
// VIP-only run scoped to EFNL cannot touch YJFL's file, because it never opens
// it. The same defect had to be fixed by hand three times — grades.json and
// gradeMeta in fetch-results, players in fetch-stats, scheduled records in
// fetch-fixtures — and this makes it structural rather than remembered.
//
// Layout: storage_ingestion_design.md §3.
//
// v2, 2026-08-12 — per-season completeness, storage_ingestion_design.md §6.1a.
// meta.phases is now keyed by season id instead of being one flag pair for the
// whole file, and the same figures are copied into the manifest so the dashboard
// can decide what to fetch without downloading an archive to find out. The file
// is authoritative if the two ever disagree. Also in v2: the loss check covers
// roster and gradeMeta, and runs before the write loop rather than after it.

'use strict';

// Bump on every change. Printed by report() so a stale copy in an Actions log
// is distinguishable from a real failure.
const STORE_VERSION = 'v2 2026-08-12 per-season-phases';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const ORGS_DIR = path.join(DATA_DIR, 'orgs');
const CORE_PATH = path.join(DATA_DIR, 'core.json');

// Keys held per organisation, split by the competition on each record or the
// first segment of each key.
const ARRAY_KEYS = ['matches', 'players'];
const PREFIX_KEYS = ['roster', 'gradeMeta'];

// Keys that cannot be split and live in core.json. Each reason is recorded in
// storage_ingestion_design.md §3 — "it ended up in core" is not reviewable.
const CORE_KEYS = [
  'clubs',       // cross-organisation: a club plays in more than one competition
  'teamClub',    // cross-organisation, consumed globally
  'teamOrg',     // cross-organisation, same shape as teamClub
  'compLogos',   // one per competition, trivially small
  'teamLogos',   // keyed by bare team name with NO competition
  'gotwFlags',   // keyed age|round with NO competition
  'lastRound',   // keyed age|rawGrade with NO competition
];

const TIMESTAMP_KEYS = [
  'lastUpdated', 'lastResultsFetch', 'lastStatsFetch',
  'lastFixtureFetch', 'lastClubIndex', 'exportedAt',
];

function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    throw new Error(`could not parse ${p}: ${e.message}`);
  }
}

function loadCore() {
  const core = readJson(CORE_PATH, null);
  if (!core) {
    throw new Error(
      `data/core.json not found. Run the "Discover seasons" workflow, then ` +
      `"Split data by organisation", before any writer can use this layout.`
    );
  }
  if (!Array.isArray(core.manifest) || !core.manifest.length) {
    throw new Error('data/core.json has no manifest — run "Discover seasons".');
  }
  return core;
}

// compName -> manifest entry. A competition with no entry cannot be placed, and
// that is reported by the caller rather than silently dropped.
function compIndex(core) {
  const idx = new Map();
  for (const m of core.manifest) if (m.compName) idx.set(m.compName, m);
  return idx;
}

function orgFilePath(org, kind) {
  return path.join(ORGS_DIR, `${org}-${kind}.json`);
}

function listOrgFiles() {
  if (!fs.existsSync(ORGS_DIR)) return [];
  return fs.readdirSync(ORGS_DIR).filter((f) => /^[0-9a-f]{8}-(current|archive)\.json$/.test(f));
}

// Which organisation files hold the given competitions. Null scope means every
// file present, which is what a full run wants.
//
// existingOnly distinguishes the two callers, and getting it wrong silently
// destroyed records. load() wants files that exist, because it can only read
// those. save() wants every file the scope COVERS, existing or not — a backfill
// scoped to a retired season needs to CREATE that organisation's -archive.json,
// and filtering it out here meant the bucket was dropped and the run still
// reported success.
function filesForScope(core, scope, existingOnly) {
  if (!scope) return listOrgFiles().map((f) => path.join(ORGS_DIR, f));
  const idx = compIndex(core);
  const wanted = new Set();
  for (const comp of scope) {
    const e = idx.get(comp);
    if (!e) continue;
    wanted.add(orgFilePath(e.org, e.retired ? 'archive' : 'current'));
    // A scoped run must also open the archive, because a season that retired
    // since the last run still has its records sitting in current.
    wanted.add(orgFilePath(e.org, 'archive'));
    wanted.add(orgFilePath(e.org, 'current'));
  }
  return existingOnly ? [...wanted].filter((p) => fs.existsSync(p)) : [...wanted];
}

/**
 * Load data in the shape data.json had.
 * @param {Iterable<string>|null} scope competition names, or null for everything
 */
function load(scope) {
  const core = loadCore();
  const scopeSet = scope ? new Set(scope) : null;

  const data = { matches: [], players: [], roster: {}, gradeMeta: {} };
  for (const k of CORE_KEYS) if (core[k] !== undefined) data[k] = core[k];
  for (const k of TIMESTAMP_KEYS) if (core[k] !== undefined) data[k] = core[k];

  const files = filesForScope(core, scopeSet, true);
  for (const p of files) {
    const payload = readJson(p, null);
    if (!payload) continue;
    for (const k of ARRAY_KEYS) if (Array.isArray(payload[k])) data[k].push(...payload[k]);
    for (const k of PREFIX_KEYS) Object.assign(data[k], payload[k] || {});
  }

  // Kept for save() so an unscoped save knows what it started from.
  Object.defineProperty(data, '__core', { value: core, enumerable: false });
  Object.defineProperty(data, '__scope', { value: scopeSet, enumerable: false });
  Object.defineProperty(data, '__filesRead', { value: files, enumerable: false });
  return data;
}

/**
 * Distribute data back to the organisation files and core.json.
 * Only files covered by scope are rewritten.
 * @returns {{written: string[], skipped: number, emptied: string[],
 *            unplaced: object, rolledOver: object[], seasonPhases: object[]}}
 */
function save(data, scope) {
  const core = data.__core || loadCore();
  const idx = compIndex(core);
  const scopeSet = scope ? new Set(scope) : null;

  // Bucket every record by the file it belongs in, and count it against the
  // season it came from. The per-season counts are what meta.phases is built
  // from: a single flag per file cannot describe an archive holding three
  // seasons, one of which has players and two of which do not.
  const buckets = new Map();
  const unplaced = {};
  const rolledOverSeen = new Set();
  const rolledOver = [];

  function bucket(entry) {
    const kind = entry.retired ? 'archive' : 'current';
    const key = `${entry.org}|${kind}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        org: entry.org, kind,
        seasons: new Set(), counts: new Map(),
        matches: [], players: [], roster: {}, gradeMeta: {},
      });
    }
    const b = buckets.get(key);
    b.seasons.add(entry.seasonId);
    if (!b.counts.has(entry.seasonId)) {
      b.counts.set(entry.seasonId, { matches: 0, players: 0, roster: 0, gradeMeta: 0 });
    }
    return b;
  }

  // Returns the bucket AND the season the record belongs to. A record carries
  // compName and nothing else, so the season id has to come from the manifest
  // at the same point the organisation does.
  function place(compName, key) {
    const e = idx.get(compName);
    if (!e) {
      if (!unplaced[key]) unplaced[key] = {};
      const c = compName || '(none)';
      unplaced[key][c] = (unplaced[key][c] || 0) + 1;
      return null;
    }
    // A season that retired since the last run has its records in -current;
    // bucketing by the manifest's retired flag moves them to -archive, and both
    // files are rewritten below, which is the rollover. Recorded once per
    // season — it used to be pushed once per record, which produced thousands
    // of identical entries on a backfill.
    if (e.retired && !rolledOverSeen.has(e.seasonId)) {
      rolledOverSeen.add(e.seasonId);
      rolledOver.push({ comp: compName, org: e.org, seasonId: e.seasonId });
    }
    return { b: bucket(e), seasonId: e.seasonId };
  }

  for (const k of ARRAY_KEYS) {
    for (const rec of data[k] || []) {
      const r = place(rec.compName, k);
      if (!r) continue;
      r.b[k].push(rec);
      r.b.counts.get(r.seasonId)[k]++;
    }
  }
  for (const k of PREFIX_KEYS) {
    for (const [kk, vv] of Object.entries(data[k] || {})) {
      const comp = kk.slice(0, kk.indexOf('|'));
      const r = place(comp, k);
      if (!r) continue;
      r.b[k][kk] = vv;
      r.b.counts.get(r.seasonId)[k]++;
    }
  }

  // Which files this save is allowed to touch. Anything outside the scope keeps
  // whatever it already holds — that is the property that makes a VIP-only run
  // safe by construction. Files the scope COVERS, not files that exist, so a
  // backfill can create an organisation's first -archive.json.
  const allowed = scopeSet ? new Set(filesForScope(core, scopeSet, false)) : null;
  const inScope = (b) => !allowed || allowed.has(orgFilePath(b.org, b.kind));

  // ── The loss check, BEFORE anything is written ──────────────────────────────
  // A save that cannot prove it kept everything is not a save. Count what came
  // in against what reached a bucket inside scope; anything skipped or unplaced
  // is a record that will not be on disk.
  //
  // Two changes from the first version. It covers PREFIX_KEYS as well as
  // ARRAY_KEYS, because a roster or gradeMeta key with no manifest entry used to
  // be dropped with a warning while the save exited zero. And it runs before the
  // write loop rather than after it, because a save that throws should not
  // already have rewritten half the files.
  const bucketed = {};
  for (const k of [...ARRAY_KEYS, ...PREFIX_KEYS]) bucketed[k] = 0;
  for (const b of buckets.values()) {
    if (!inScope(b)) continue;
    for (const k of ARRAY_KEYS) bucketed[k] += b[k].length;
    for (const k of PREFIX_KEYS) bucketed[k] += Object.keys(b[k]).length;
  }
  const lost = {};
  for (const k of ARRAY_KEYS) {
    const n = (data[k] || []).length;
    if (bucketed[k] !== n) lost[k] = { in: n, would: bucketed[k] };
  }
  for (const k of PREFIX_KEYS) {
    const n = Object.keys(data[k] || {}).length;
    if (bucketed[k] !== n) lost[k] = { in: n, would: bucketed[k] };
  }
  if (Object.keys(lost).length) {
    for (const [key, comps] of Object.entries(unplaced)) {
      for (const [c, n] of Object.entries(comps)) {
        console.error(`  ${key}: ${n} record(s) for "${c}" have no manifest entry`);
      }
    }
    const detail = Object.entries(lost)
      .map(([k, v]) => `${k}: ${v.in} in, ${v.would} would be written`).join('; ');
    throw new Error(
      `store.save would lose records — ${detail}. NOTHING HAS BEEN WRITTEN. ` +
      `Either a bucket fell outside the scope, or a competition is missing from ` +
      `the manifest — run "Discover seasons" if a season is new.`
    );
  }

  // Recorded before writing, so "emptied" means a file that HAD content and now
  // has none — not one that never existed.
  const existedBefore = new Set(listOrgFiles().map((f) => path.join(ORGS_DIR, f)));
  fs.mkdirSync(ORGS_DIR, { recursive: true });

  const written = [];
  const seasonPhases = new Map();
  let skipped = 0;

  for (const b of buckets.values()) {
    const p = orgFilePath(b.org, b.kind);
    if (!inScope(b)) { skipped++; continue; }

    // Per season, not per file. The counts are stored alongside the flags so a
    // claim of results:true has a number behind it that can be checked.
    const phases = {};
    for (const [seasonId, c] of b.counts) {
      phases[seasonId] = {
        results: c.matches > 0,
        players: c.players > 0,
        matches: c.matches,
        players_n: c.players,
      };
      seasonPhases.set(seasonId, phases[seasonId]);
    }

    const payload = {
      meta: {
        org: b.org,
        kind: b.kind,
        seasons: [...b.seasons].sort(),
        generatedAt: new Date().toISOString(),
        phases,
      },
      matches: b.matches,
      players: b.players,
      roster: b.roster,
      gradeMeta: b.gradeMeta,
    };
    // Minified, as data.json was. Every writer must agree or the next run
    // re-inflates the file and produces a whole-file diff.
    fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
    written.push(path.relative(ROOT, p));
  }

  // An organisation file that this scope covers but which produced no bucket
  // means every record for it was removed. Emptying a file is a legitimate
  // outcome only when the writer meant it, so it is reported, not silent.
  const emptied = [];
  if (allowed) {
    for (const p of allowed) {
      const rel = path.relative(ROOT, p);
      if (!written.includes(rel) && existedBefore.has(p)) emptied.push(rel);
    }
  }

  const nextCore = { ...core };
  for (const k of CORE_KEYS) if (data[k] !== undefined) nextCore[k] = data[k];
  for (const k of TIMESTAMP_KEYS) if (data[k] !== undefined) nextCore[k] = data[k];

  // The manifest carries a COPY of the completeness signal, because the
  // dashboard has to decide what to fetch before it fetches it, and a flag
  // readable only from inside a 10 MB archive cannot inform that decision.
  //
  // It is DERIVED here from the buckets just written, never maintained by hand
  // and never written anywhere else. The file and the manifest cannot drift if
  // one thing writes both in one pass.
  //
  // The FILE is authoritative if they ever do disagree. Deleting an organisation
  // file by hand would leave a stale entry here and nothing detects it. A season
  // this run produced no bucket for keeps whatever it already had, so a scoped
  // run cannot blank the seasons it did not cover.
  // storage_ingestion_design.md §6.1a.
  nextCore.manifest = core.manifest.map((m) =>
    seasonPhases.has(m.seasonId) ? { ...m, phases: seasonPhases.get(m.seasonId) } : m);

  // Record which organisation files actually exist. Without it the dashboard
  // has to guess from the manifest, and an organisation that is configured but
  // never fetched costs every visitor a 404 — twelve of them, currently.
  // Rebuilt from the directory rather than accumulated, so a deleted file
  // disappears from the index instead of lingering.
  nextCore.orgFiles = listOrgFiles().sort().map((f) => {
    const full = path.join(ORGS_DIR, f);
    const [org, kindExt] = f.split('-');
    return { file: `data/orgs/${f}`, org, kind: kindExt.replace('.json', ''), bytes: fs.statSync(full).size };
  });

  fs.writeFileSync(CORE_PATH, JSON.stringify(nextCore, null, 2), 'utf8');

  return {
    written, skipped, emptied, unplaced, rolledOver,
    seasonPhases: [...seasonPhases].map(([seasonId, p]) => ({ seasonId, ...p })),
  };
}

/**
 * Write ONLY the cross-organisation keys back to core.json.
 * For writers that touch nothing per-organisation — build-club-index.js changes
 * clubs and teamClub and nothing else. Calling save() there would rewrite every
 * organisation file with a fresh generatedAt and produce a whole-file diff on
 * every run.
 */
function saveCore(data) {
  const core = data.__core || loadCore();
  const next = { ...core };
  for (const k of CORE_KEYS) if (data[k] !== undefined) next[k] = data[k];
  for (const k of TIMESTAMP_KEYS) if (data[k] !== undefined) next[k] = data[k];
  next.orgFiles = listOrgFiles().sort().map((f) => {
    const full = path.join(ORGS_DIR, f);
    const [org, kindExt] = f.split('-');
    return { file: `data/orgs/${f}`, org, kind: kindExt.replace('.json', ''), bytes: fs.statSync(full).size };
  });
  fs.writeFileSync(CORE_PATH, JSON.stringify(next, null, 2), 'utf8');
  return { written: ['data/core.json'], skipped: 0, emptied: [], unplaced: {}, rolledOver: [] };
}

// Competition names that are live, from the manifest. Lets a writer restrict
// itself to seasons that can still change.
function liveComps(statuses) {
  const core = loadCore();
  const want = new Set(statuses || ['ACTIVE', 'UPCOMING']);
  return core.manifest.filter((m) => m.compName && want.has(m.status)).map((m) => m.compName);
}

function report(result, label) {
  const parts = [`${result.written.length} file(s) written`];
  if (result.skipped) parts.push(`${result.skipped} outside scope, untouched`);
  if (result.emptied.length) parts.push(`${result.emptied.length} EMPTIED`);
  // The version is printed on every run so a stale copy in a log is
  // distinguishable from a real failure. Without it the two look identical.
  console.log(`[${label || 'store'} ${STORE_VERSION}] ${parts.join(', ')}`);
  for (const f of result.written) console.log(`  wrote ${f}`);
  // Per-season completeness, so the log shows what was actually recorded
  // rather than only that something was.
  for (const s of result.seasonPhases || []) {
    console.log(
      `  season ${s.seasonId}: results=${s.results} (${s.matches} matches), ` +
      `players=${s.players} (${s.players_n} players)`
    );
  }
  for (const r of result.rolledOver || []) {
    console.log(`  rolled over to archive: ${r.comp} (season ${r.seasonId})`);
  }
  if (result.emptied.length) {
    console.warn('  WARNING: these files were covered by this run but received no records:');
    for (const f of result.emptied) console.warn(`    ${f}`);
  }
  for (const [key, comps] of Object.entries(result.unplaced || {})) {
    console.warn(`  WARNING: ${key} records with no manifest entry — NOT SAVED:`);
    for (const [c, n] of Object.entries(comps)) console.warn(`    ${c}: ${n}`);
  }
}

module.exports = { load, save, saveCore, liveComps, report, CORE_PATH, ORGS_DIR, CORE_KEYS };
