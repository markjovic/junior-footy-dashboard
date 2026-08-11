// scripts/split-data.js
//
// One-time migration: turns data/data.json into per-organisation files, using
// the manifest in data/core.json to decide which organisation and which file
// each competition-season belongs to.
//
// NON-DESTRUCTIVE. data.json is not modified or deleted. The split is written
// alongside it so the result can be inspected and verified before anything reads
// it. Nothing in the dashboard or the fetchers changes until they are pointed at
// the new layout.
//
// It verifies its own output by reassembling the split files and comparing them
// against the source, key by key and record by record. A migration that cannot
// prove it lost nothing is not a migration.
//
// Layout produced (storage_ingestion_design.md §3):
//   data/orgs/<code>-current.json    live seasons
//   data/orgs/<code>-archive.json    retired seasons
//   data/core.json                   cross-organisation data, merged in
//
// Exit codes: 0 = wrote a split, 2 = nothing to do, 1 = fatal or verification
// failed.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data', 'data.json');
const CORE_PATH = path.join(ROOT, 'data', 'core.json');
const ORGS_DIR = path.join(ROOT, 'data', 'orgs');

// Keys that split cleanly, because the competition is on the record or is the
// first segment of the key.
const SPLIT_ARRAY_KEYS = ['matches', 'players'];
const SPLIT_PREFIX_KEYS = ['roster', 'gradeMeta'];

// Keys that CANNOT be split, and why. Each is stated rather than silently
// lumped into core.json, because "it ended up in core" is not a decision anyone
// can review later.
const CORE_KEYS = {
  clubs: 'cross-organisation by design — a club plays in more than one competition',
  teamClub: 'cross-organisation by design, keyed comp|team|age but consumed globally',
  teamOrg: 'cross-organisation by design, same shape as teamClub',
  compLogos: 'one entry per competition, trivially small, read for every competition tab',
  teamLogos: 'keyed by bare team name with NO competition — cannot be split without changing the key. See storage_ingestion_design.md §3',
  gotwFlags: 'keyed age|round with NO competition — same defect as lastRound, and it collides across competitions. See §3',
  lastRound: 'keyed age|rawGrade with NO competition — moved per organisation below where possible',
};

function log(...a) { console.log(...a); }
function human(b) { return b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`; }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padL(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }

function readJson(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`FATAL: ${label} not found at ${p}`);
    process.exit(1);
  }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) {
    console.error(`FATAL: could not parse ${label}: ${e.message}`);
    process.exit(1);
  }
}

function main() {
  const data = readJson(DATA_PATH, 'data.json');
  const core = readJson(CORE_PATH, 'core.json');

  const manifest = core.manifest || [];
  if (!manifest.length) {
    console.error('FATAL: core.json has no manifest. Run the "Discover seasons" workflow first.');
    process.exit(1);
  }

  // compName -> { org, seasonId, retired }. compName is what every stored record
  // carries; the manifest is the only thing that maps it to an organisation.
  const byCompName = new Map();
  for (const m of manifest) {
    if (m.compName) byCompName.set(m.compName, m);
  }
  log(`Manifest: ${manifest.length} season(s), ${byCompName.size} with a resolved compName`);

  // ── Bucket every record by organisation and file kind ─────────────────────
  const buckets = new Map(); // "code|current" -> partial data object
  const unplaced = { matches: [], players: [], roster: [], gradeMeta: [], lastRound: [] };
  const unknownComps = new Map();

  function bucketFor(entry) {
    const kind = entry.retired ? 'archive' : 'current';
    const key = `${entry.org}|${kind}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        org: entry.org, kind,
        matches: [], players: [], roster: {}, gradeMeta: {}, lastRound: {},
        seasons: [],
      });
    }
    const b = buckets.get(key);
    if (!b.seasons.includes(entry.seasonId)) b.seasons.push(entry.seasonId);
    return b;
  }

  function place(compName) {
    const entry = byCompName.get(compName);
    if (!entry) {
      unknownComps.set(compName, (unknownComps.get(compName) || 0) + 1);
      return null;
    }
    return bucketFor(entry);
  }

  for (const key of SPLIT_ARRAY_KEYS) {
    for (const rec of data[key] || []) {
      const b = place(rec.compName);
      if (!b) { unplaced[key].push(rec); continue; }
      b[key].push(rec);
    }
  }

  for (const key of SPLIT_PREFIX_KEYS) {
    for (const [k, v] of Object.entries(data[key] || {})) {
      const comp = k.slice(0, k.indexOf('|'));
      const b = place(comp);
      if (!b) { unplaced[key].push([k, v]); continue; }
      b[key][k] = v;
    }
  }

  // lastRound is keyed age|rawGrade with no competition, so it cannot be
  // attributed. It is carried whole into core.json and left for the writers to
  // rebuild correctly per organisation — where the competition IS the filename
  // and the key becomes correct by construction.
  const lastRoundCount = Object.keys(data.lastRound || {}).length;

  // ── Write the organisation files ──────────────────────────────────────────
  fs.mkdirSync(ORGS_DIR, { recursive: true });
  const written = [];
  let totalBytes = 0;

  for (const b of [...buckets.values()].sort((a, x) => a.org.localeCompare(x.org) || a.kind.localeCompare(x.kind))) {
    const payload = {
      meta: {
        org: b.org,
        kind: b.kind,
        seasons: b.seasons.sort(),
        generatedAt: new Date().toISOString(),
        source: 'split-data.js',
        // Absent is not the same as empty. A season awaiting the player backfill
        // must be distinguishable from one whose players are genuinely missing.
        phases: { results: b.matches.length > 0, players: b.players.length > 0 },
      },
      matches: b.matches,
      players: b.players,
      roster: b.roster,
      gradeMeta: b.gradeMeta,
    };
    const file = path.join(ORGS_DIR, `${b.org}-${b.kind}.json`);
    const text = JSON.stringify(payload);
    fs.writeFileSync(file, text, 'utf8');
    totalBytes += text.length;
    written.push({ file: `data/orgs/${b.org}-${b.kind}.json`, bytes: text.length, ...b });
  }

  log(`\n=== organisation files written ===`);
  log(`  ${pad('file', 34)}${padL('bytes', 11)}${padL('matches', 10)}${padL('players', 10)}${padL('roster', 9)}`);
  for (const w of written) {
    log(`  ${pad(w.file, 34)}${padL(human(w.bytes), 11)}${padL(w.matches.length, 10)}${padL(w.players.length, 10)}${padL(Object.keys(w.roster).length, 9)}`);
  }
  log(`  ${pad('TOTAL', 34)}${padL(human(totalBytes), 11)}`);

  // ── Anything that could not be placed ─────────────────────────────────────
  const unplacedTotal = Object.values(unplaced).reduce((a, v) => a + v.length, 0);
  if (unknownComps.size) {
    log(`\n=== ⚠️ records whose competition is not in the manifest ===`);
    log('These are NOT in any organisation file. They are still in data.json and are');
    log('not lost, but they would disappear the moment data.json stops being read.');
    for (const [comp, n] of [...unknownComps.entries()].sort((a, b) => b[1] - a[1])) {
      log(`  ${pad(comp, 40)} ${n} record(s)`);
    }
  }

  // ── Verify by reassembly ──────────────────────────────────────────────────
  // Reading the code and believing it split correctly is not verification.
  log(`\n=== verification: reassemble and compare ===`);
  const rebuilt = { matches: [], players: [], roster: {}, gradeMeta: {} };
  for (const f of fs.readdirSync(ORGS_DIR).filter((x) => x.endsWith('.json')).sort()) {
    const p = JSON.parse(fs.readFileSync(path.join(ORGS_DIR, f), 'utf8'));
    rebuilt.matches.push(...(p.matches || []));
    rebuilt.players.push(...(p.players || []));
    Object.assign(rebuilt.roster, p.roster || {});
    Object.assign(rebuilt.gradeMeta, p.gradeMeta || {});
  }
  for (const k of SPLIT_ARRAY_KEYS) rebuilt[k].push(...unplaced[k]);
  for (const k of SPLIT_PREFIX_KEYS) for (const [kk, vv] of unplaced[k]) rebuilt[k][kk] = vv;

  // Sort by the SERIALISED record, not by an id field. Player records have no
  // `id` and their `uuid` repeats — one record per age per competition — so
  // sorting on uuid left ties, and Array.sort being stable meant the two sides
  // kept their own input orders and compared unequal despite holding identical
  // records. Serialising first is a total order by construction.
  const canonArr = (a) => JSON.stringify(a.map((x) => JSON.stringify(x)).sort());
  const canonObj = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

  let ok = true;
  for (const k of SPLIT_ARRAY_KEYS) {
    const a = canonArr(data[k] || []);
    const b = canonArr(rebuilt[k]);
    const same = a === b;
    if (!same) ok = false;
    log(`  ${pad(k, 12)} source ${padL((data[k] || []).length, 7)}  rebuilt ${padL(rebuilt[k].length, 7)}  ${same ? 'IDENTICAL' : '*** MISMATCH ***'}`);
  }
  for (const k of SPLIT_PREFIX_KEYS) {
    const a = canonObj(data[k] || {});
    const b = canonObj(rebuilt[k]);
    const same = a === b;
    if (!same) ok = false;
    log(`  ${pad(k, 12)} source ${padL(Object.keys(data[k] || {}).length, 7)}  rebuilt ${padL(Object.keys(rebuilt[k]).length, 7)}  ${same ? 'IDENTICAL' : '*** MISMATCH ***'}`);
  }

  if (!ok) {
    console.error('\nFATAL: reassembly does not match the source. The split is WRONG — nothing');
    console.error('should be pointed at these files. data.json is untouched.');
    process.exit(1);
  }
  log('  Every split key round-trips exactly.');

  // ── Merge the unsplittable keys into core.json ────────────────────────────
  log(`\n=== carried into core.json (cannot be split) ===`);
  const nextCore = { ...core };
  for (const [k, why] of Object.entries(CORE_KEYS)) {
    if (data[k] === undefined) continue;
    nextCore[k] = data[k];
    const n = Array.isArray(data[k]) ? data[k].length : Object.keys(data[k]).length;
    log(`  ${pad(k, 12)} ${padL(n, 7)} entr(y|ies) — ${why}`);
  }
  nextCore.lastSplit = new Date().toISOString();
  nextCore.orgFiles = written.map((w) => ({ file: w.file, org: w.org, kind: w.kind, seasons: w.seasons, bytes: w.bytes }));

  fs.writeFileSync(CORE_PATH, JSON.stringify(nextCore, null, 2), 'utf8');
  log(`\nWrote ${CORE_PATH} (${human(fs.statSync(CORE_PATH).size)})`);

  const dataSize = fs.statSync(DATA_PATH).size;
  log(`\n=== size ===`);
  log(`  data.json (unchanged)   ${padL(human(dataSize), 11)}`);
  log(`  organisation files      ${padL(human(totalBytes), 11)}`);
  log(`  largest single file     ${padL(human(Math.max(...written.map((w) => w.bytes))), 11)}`);
  log(`  GitHub per-file limit   ${padL('100.00 MB', 11)}`);

  log('\ndata.json was NOT modified. Nothing reads the new files yet.');
  if (unplacedTotal) {
    log(`\n⚠️ ${unplacedTotal} record(s) were not placed — see above. Resolve before`);
    log('   anything is pointed at the new layout.');
  }
  process.exit(0);
}

main();
