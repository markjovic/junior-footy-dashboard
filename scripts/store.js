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

'use strict';

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
function filesForScope(core, scope) {
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
  return [...wanted].filter((p) => fs.existsSync(p));
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

  const files = filesForScope(core, scopeSet);
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
 * @returns {{written: string[], skipped: number, unplaced: object, rolledOver: object[]}}
 */
function save(data, scope) {
  const core = data.__core || loadCore();
  const idx = compIndex(core);
  const scopeSet = scope ? new Set(scope) : null;

  // Bucket every record by the file it belongs in.
  const buckets = new Map();
  const unplaced = {};
  const rolledOver = [];

  function bucket(entry) {
    const kind = entry.retired ? 'archive' : 'current';
    const key = `${entry.org}|${kind}`;
    if (!buckets.has(key)) {
      buckets.set(key, { org: entry.org, kind, seasons: new Set(), matches: [], players: [], roster: {}, gradeMeta: {} });
    }
    const b = buckets.get(key);
    b.seasons.add(entry.seasonId);
    return b;
  }

  function place(compName, key) {
    const e = idx.get(compName);
    if (!e) {
      if (!unplaced[key]) unplaced[key] = {};
      unplaced[key][compName || '(none)'] = (unplaced[key][compName || '(none)'] || 0) + 1;
      return null;
    }
    // A season that retired since the last run has its records in -current;
    // bucketing by the manifest's current flag moves them to -archive, and both
    // files are rewritten below, which is the rollover.
    if (e.retired) rolledOver.push({ comp: compName, org: e.org, seasonId: e.seasonId });
    return bucket(e);
  }

  for (const k of ARRAY_KEYS) {
    for (const rec of data[k] || []) {
      const b = place(rec.compName, k);
      if (b) b[k].push(rec);
    }
  }
  for (const k of PREFIX_KEYS) {
    for (const [kk, vv] of Object.entries(data[k] || {})) {
      const comp = kk.slice(0, kk.indexOf('|'));
      const b = place(comp, k);
      if (b) b[k][kk] = vv;
    }
  }

  // Which files this save is allowed to touch. Anything outside the scope keeps
  // whatever it already holds — that is the property that makes a VIP-only run
  // safe by construction.
  const allowed = scopeSet ? new Set(filesForScope(core, scopeSet)) : null;

  fs.mkdirSync(ORGS_DIR, { recursive: true });
  const written = [];
  let skipped = 0;

  for (const b of buckets.values()) {
    const p = orgFilePath(b.org, b.kind);
    if (allowed && !allowed.has(p) && !fs.existsSync(p)) { skipped++; continue; }
    if (allowed && !allowed.has(p)) { skipped++; continue; }

    const payload = {
      meta: {
        org: b.org,
        kind: b.kind,
        seasons: [...b.seasons].sort(),
        generatedAt: new Date().toISOString(),
        phases: { results: b.matches.length > 0, players: b.players.length > 0 },
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
      if (!written.includes(rel) && fs.existsSync(p)) emptied.push(rel);
    }
  }

  const nextCore = { ...core };
  for (const k of CORE_KEYS) if (data[k] !== undefined) nextCore[k] = data[k];
  for (const k of TIMESTAMP_KEYS) if (data[k] !== undefined) nextCore[k] = data[k];
  fs.writeFileSync(CORE_PATH, JSON.stringify(nextCore, null, 2), 'utf8');

  return { written, skipped, emptied, unplaced, rolledOver };
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
  console.log(`[${label || 'store'}] ${parts.join(', ')}`);
  for (const f of result.written) console.log(`  wrote ${f}`);
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
