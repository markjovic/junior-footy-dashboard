// scripts/lib/store.js
//
// The per-season storage layer. Every writer goes through this instead of
// reading and writing data files directly.
//
//   const store = require('./lib/store');
//   const data = store.load(compNames);   // same shape data.json had
//   ... unchanged writer logic ...
//   store.save(data, compNames);          // distributed back, one file per season
//
// LAYOUT — per_season_storage_design.md
//
//   data/core.json                     manifest + cross-organisation keys
//   data/seasons/<seasonId>-core.json  matches, roster, gradeMeta, meta
//   data/seasons/<seasonId>-players.json   players
//
// Season ids are PlayHQ's and globally unique, so the organisation is not in the
// path, and there is no -current/-archive distinction: a season is a season, and
// the manifest says whether it is retired. Records therefore never move between
// files, which removes the rollover machinery and the ordering problem recorded
// in storage_ingestion_design.md §3.2.
//
// WHY PLAYERS ARE SEPARATE
// Measured 2026-08-12: 78% of all stored bytes are player records, and the
// dashboard fetched 26.27 MB on every page view of which 18.87 MB was players it
// did not read until someone opened Scorers. Splitting them lets a reader take
// the ladder without the statistics.
//
// WHY IT LOOKS LIKE THE OLD SHAPE
// load() returns { matches, players, roster, gradeMeta, teamLogos, ... } exactly
// as before, so no writer's logic changes. Only where the bytes live changes.
//
// WHY SCOPING MATTERS
// save(data, scope) rewrites ONLY the seasons covered by scope. A VIP-only run
// scoped to EFNL cannot touch YJFL, because it never opens its files. The same
// defect had to be fixed by hand four times before this was made structural.

'use strict';

const fs = require('fs');
const path = require('path');

// Bump on every change. Printed by report() so a stale copy in an Actions log is
// distinguishable from a real failure.
const STORE_VERSION = 'v4 2026-08-12 write-only-if-changed';

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const SEASONS_DIR = path.join(DATA_DIR, 'seasons');
const CORE_PATH = path.join(DATA_DIR, 'core.json');

// Keys held per season, split by the competition on each record or the first
// segment of each key.
const ARRAY_KEYS = ['matches', 'players'];
const PREFIX_KEYS = ['roster', 'gradeMeta'];

// Which file each key lives in. players is alone because it is 78% of the bytes
// and is not needed to render a ladder.
const CORE_FILE_KEYS = ['matches', 'roster', 'gradeMeta'];
const PLAYER_FILE_KEYS = ['players'];

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

// Compare what is about to be written against what is on disk, ignoring the
// timestamp. Without this every run rewrote all 36 files even when it changed
// half of them: a results run touches matches and never players, and a stats run
// the reverse. Doing it here rather than asking each writer to declare what it
// skips means a new writer gets the same protection without being told, and a
// forgotten rule cannot cost a rewrite.
//
// generatedAt is excluded because it changes on every run and would make every
// file look different. Everything else, including meta, is compared.
function unchanged(p, payload) {
  if (!fs.existsSync(p)) return false;
  let existing;
  try { existing = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return false; }
  const strip = (o) => {
    if (!o || typeof o !== 'object') return o;
    const c = { ...o };
    if (c.meta && typeof c.meta === 'object') {
      c.meta = { ...c.meta };
      delete c.meta.generatedAt;
    }
    return c;
  };
  return JSON.stringify(strip(existing)) === JSON.stringify(strip(payload));
}

function readJson(p, fallback) {
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { throw new Error(`could not parse ${p}: ${e.message}`); }
}

function loadCore() {
  const core = readJson(CORE_PATH, null);
  if (!core) {
    throw new Error(
      `data/core.json not found. Run the "Discover seasons" workflow before any ` +
      `writer can use this layout.`
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

const corePath = (seasonId) => path.join(SEASONS_DIR, `${seasonId}-core.json`);
const playersPath = (seasonId) => path.join(SEASONS_DIR, `${seasonId}-players.json`);

function listSeasonFiles() {
  if (!fs.existsSync(SEASONS_DIR)) return [];
  return fs.readdirSync(SEASONS_DIR).filter(f => /^[0-9a-f]{8}-(core|players)\.json$/.test(f));
}

// Which seasons the given competitions belong to. Null scope means every season
// in the manifest, which is what a full run wants.
function seasonsForScope(core, scope) {
  if (!scope) return [...new Set(core.manifest.filter(m => m.compName && m.seasonId).map(m => m.seasonId))];
  const idx = compIndex(core);
  const out = new Set();
  for (const comp of scope) {
    const e = idx.get(comp);
    if (e && e.seasonId) out.add(e.seasonId);
  }
  return [...out];
}

/**
 * Load data in the shape data.json had.
 * @param {Iterable<string>|null} scope competition names, or null for everything
 * @param {{players?: boolean}} [opts] players:false skips the player files, which
 *        are 78% of the bytes and are not needed by a writer that does not touch
 *        them. fetch-results does not; fetch-stats does.
 */
function load(scope, opts) {
  const core = loadCore();
  const scopeSet = scope ? new Set(scope) : null;
  const wantPlayers = !opts || opts.players !== false;

  const data = { matches: [], players: [], roster: {}, gradeMeta: {} };
  for (const k of CORE_KEYS) if (core[k] !== undefined) data[k] = core[k];
  for (const k of TIMESTAMP_KEYS) if (core[k] !== undefined) data[k] = core[k];

  const seasons = seasonsForScope(core, scopeSet);
  const read = [];
  for (const sid of seasons) {
    const cp = corePath(sid);
    const payload = readJson(cp, null);
    if (payload) {
      read.push(path.relative(ROOT, cp));
      for (const k of CORE_FILE_KEYS) {
        if (Array.isArray(payload[k])) data[k].push(...payload[k]);
        else if (payload[k]) Object.assign(data[k], payload[k]);
      }
    }
    if (!wantPlayers) continue;
    const pp = playersPath(sid);
    const pl = readJson(pp, null);
    if (pl && Array.isArray(pl.players)) {
      read.push(path.relative(ROOT, pp));
      data.players.push(...pl.players);
    }
  }

  Object.defineProperty(data, '__core', { value: core, enumerable: false });
  Object.defineProperty(data, '__scope', { value: scopeSet, enumerable: false });
  Object.defineProperty(data, '__filesRead', { value: read, enumerable: false });
  // A save must not write a player file it never read, or it would replace every
  // player in the season with nothing.
  Object.defineProperty(data, '__hadPlayers', { value: wantPlayers, enumerable: false });
  return data;
}

/**
 * Distribute data back, one file per season. Only seasons covered by scope are
 * rewritten.
 * @returns {{written: string[], skipped: number, emptied: string[],
 *            unplaced: object, seasonPhases: object[]}}
 */
function save(data, scope) {
  const core = data.__core || loadCore();
  const idx = compIndex(core);
  const scopeSet = scope ? new Set(scope) : null;
  const wrotePlayers = data.__hadPlayers !== false;

  // Bucket every record by the season it belongs to.
  const buckets = new Map();     // seasonId -> bucket
  const unplaced = {};

  function bucket(entry) {
    if (!buckets.has(entry.seasonId)) {
      buckets.set(entry.seasonId, {
        seasonId: entry.seasonId, org: entry.org, compNames: new Set(),
        matches: [], players: [], roster: {}, gradeMeta: {},
      });
    }
    const b = buckets.get(entry.seasonId);
    b.compNames.add(entry.compName);
    return b;
  }

  function place(compName, key) {
    const e = idx.get(compName);
    if (!e || !e.seasonId) {
      if (!unplaced[key]) unplaced[key] = {};
      const c = compName || '(none)';
      unplaced[key][c] = (unplaced[key][c] || 0) + 1;
      return null;
    }
    return bucket(e);
  }

  for (const k of ARRAY_KEYS) {
    if (k === 'players' && !wrotePlayers) continue;
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

  // Which seasons this save may touch. Anything outside keeps what it holds —
  // the property that makes a VIP-only run safe by construction. Seasons the
  // scope COVERS, existing or not, so a first write can create a file.
  const allowed = scopeSet ? new Set(seasonsForScope(core, scopeSet)) : null;
  const inScope = (sid) => !allowed || allowed.has(sid);

  // ── The loss check, BEFORE anything is written ──────────────────────────────
  // A save that cannot prove it kept everything is not a save. Anything skipped
  // or unplaced is a record that will not be on disk.
  const bucketed = {};
  const checkKeys = [...ARRAY_KEYS, ...PREFIX_KEYS].filter(k => k !== 'players' || wrotePlayers);
  for (const k of checkKeys) bucketed[k] = 0;
  for (const b of buckets.values()) {
    if (!inScope(b.seasonId)) continue;
    for (const k of ARRAY_KEYS) if (checkKeys.includes(k)) bucketed[k] += b[k].length;
    for (const k of PREFIX_KEYS) bucketed[k] += Object.keys(b[k]).length;
  }
  const lost = {};
  for (const k of checkKeys) {
    const n = ARRAY_KEYS.includes(k) ? (data[k] || []).length : Object.keys(data[k] || {}).length;
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

  const existedBefore = new Set(listSeasonFiles().map(f => path.join(SEASONS_DIR, f)));
  fs.mkdirSync(SEASONS_DIR, { recursive: true });

  const written = [];
  const seasonPhases = new Map();
  let skipped = 0;
  let untouched = 0;   // in scope, but byte-identical to what is already on disk

  for (const b of buckets.values()) {
    if (!inScope(b.seasonId)) { skipped++; continue; }

    // A run that did not load players knows nothing about them, so it must
    // carry forward what the file already says rather than writing zeros. Doing
    // otherwise made the core file claim the season had no players, which is
    // both wrong and a spurious rewrite on every results run.
    const prevPhases = wrotePlayers ? null
      : ((readJson(corePath(b.seasonId), null) || {}).meta || {}).phases || {};
    const phases = {
      results: b.matches.length > 0,
      players: wrotePlayers ? b.players.length > 0 : prevPhases.players === true,
      matches: b.matches.length,
      players_n: wrotePlayers ? b.players.length : (prevPhases.players_n || 0),
    };
    // Recorded so the log can say "untouched" rather than "0 players", which
    // reads as data loss when the caller simply did not ask for them.
    seasonPhases.set(b.seasonId, wrotePlayers ? phases : { ...phases, playersUntouched: true });

    const cp = corePath(b.seasonId);
    const corePayload = {
      meta: { seasonId: b.seasonId, org: b.org, comps: [...b.compNames].sort(),
              generatedAt: new Date().toISOString(), phases },
      matches: b.matches, roster: b.roster, gradeMeta: b.gradeMeta,
    };
    if (unchanged(cp, corePayload)) { untouched++; }
    else { fs.writeFileSync(cp, JSON.stringify(corePayload), 'utf8'); written.push(path.relative(ROOT, cp)); }

    // Only when the caller loaded players. A writer that skipped them must not
    // replace a season's whole player list with an empty one.
    if (wrotePlayers) {
      const pp = playersPath(b.seasonId);
      const playersPayload = {
        meta: { seasonId: b.seasonId, generatedAt: new Date().toISOString(), count: b.players.length },
        players: b.players,
      };
      if (unchanged(pp, playersPayload)) { untouched++; }
      else { fs.writeFileSync(pp, JSON.stringify(playersPayload), 'utf8'); written.push(path.relative(ROOT, pp)); }
    }
  }

  // A season this scope covers but which produced no bucket means every record
  // for it was removed. Emptying is legitimate only when the writer meant it.
  const emptied = [];
  if (allowed) {
    for (const sid of allowed) {
      const cp = corePath(sid);
      const rel = path.relative(ROOT, cp);
      // A season that produced a bucket but was unchanged is not emptied — it
      // is identical. Only one with no bucket at all has lost its records.
      if (!written.includes(rel) && existedBefore.has(cp) && !seasonPhases.has(sid)) emptied.push(rel);
    }
  }

  const nextCore = { ...core };
  for (const k of CORE_KEYS) if (data[k] !== undefined) nextCore[k] = data[k];
  for (const k of TIMESTAMP_KEYS) if (data[k] !== undefined) nextCore[k] = data[k];

  // The manifest carries a DERIVED copy of the completeness signal, so the
  // dashboard can decide what to fetch before fetching it. A season this run
  // produced no bucket for keeps what it had. The file is authoritative if the
  // two ever disagree. storage_ingestion_design.md §6.1a.
  //
  // A run that skipped players must not report players:false for a season whose
  // player file is untouched — it would say the data is missing when it is not.
  nextCore.manifest = core.manifest.map(m => {
    const p = seasonPhases.get(m.seasonId);
    if (!p) return m;
    const { playersUntouched, ...phases } = p;
    return { ...m, phases };
  });

  nextCore.seasonFiles = listSeasonFiles().sort().map(f => {
    const full = path.join(SEASONS_DIR, f);
    const [seasonId, kindExt] = f.split('-');
    return { file: `data/seasons/${f}`, seasonId, kind: kindExt.replace('.json', ''),
             bytes: fs.statSync(full).size };
  });
  delete nextCore.orgFiles;   // the previous layout's index

  fs.writeFileSync(CORE_PATH, JSON.stringify(nextCore, null, 2), 'utf8');

  return {
    written, skipped, untouched, emptied, unplaced,
    seasonPhases: [...seasonPhases].map(([seasonId, p]) => ({ seasonId, ...p })),
  };
}

/**
 * Write ONLY the cross-organisation keys back to core.json.
 * For writers that touch nothing per-season — build-club-index.js changes clubs
 * and teamClub and nothing else. Calling save() there would rewrite every season
 * file with a fresh generatedAt and produce a whole-file diff on every run.
 */
function saveCore(data) {
  const core = data.__core || loadCore();
  const next = { ...core };
  for (const k of CORE_KEYS) if (data[k] !== undefined) next[k] = data[k];
  for (const k of TIMESTAMP_KEYS) if (data[k] !== undefined) next[k] = data[k];
  next.seasonFiles = listSeasonFiles().sort().map(f => {
    const full = path.join(SEASONS_DIR, f);
    const [seasonId, kindExt] = f.split('-');
    return { file: `data/seasons/${f}`, seasonId, kind: kindExt.replace('.json', ''),
             bytes: fs.statSync(full).size };
  });
  delete next.orgFiles;
  fs.writeFileSync(CORE_PATH, JSON.stringify(next, null, 2), 'utf8');
  return { written: ['data/core.json'], skipped: 0, untouched: 0, emptied: [], unplaced: {}, seasonPhases: [] };
}

// Competition names that are live, from the manifest. Lets a writer restrict
// itself to seasons that can still change.
function liveComps(statuses) {
  const core = loadCore();
  const want = new Set(statuses || ['ACTIVE', 'UPCOMING']);
  return core.manifest.filter(m => m.compName && want.has(m.status)).map(m => m.compName);
}

function report(result, label) {
  const parts = [`${result.written.length} file(s) written`];
  if (result.untouched) parts.push(`${result.untouched} unchanged, not rewritten`);
  if (result.skipped) parts.push(`${result.skipped} outside scope, untouched`);
  if (result.emptied.length) parts.push(`${result.emptied.length} EMPTIED`);
  console.log(`[${label || 'store'} ${STORE_VERSION}] ${parts.join(', ')}`);
  for (const f of result.written) console.log(`  wrote ${f}`);
  for (const s of result.seasonPhases || []) {
    const players = s.playersUntouched
      ? 'players untouched (not loaded by this run)'
      : `players=${s.players} (${s.players_n} players)`;
    console.log(`  season ${s.seasonId}: results=${s.results} (${s.matches} matches), ${players}`);
  }
  if (result.emptied.length) {
    console.warn('  WARNING: these seasons were covered by this run but received no records:');
    for (const f of result.emptied) console.warn(`    ${f}`);
  }
  for (const [key, comps] of Object.entries(result.unplaced || {})) {
    console.warn(`  WARNING: ${key} records with no manifest entry — NOT SAVED:`);
    for (const [c, n] of Object.entries(comps)) console.warn(`    ${c}: ${n}`);
  }
}

module.exports = {
  load, save, saveCore, liveComps, report,
  CORE_PATH, SEASONS_DIR, CORE_KEYS, STORE_VERSION,
};
