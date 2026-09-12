#!/usr/bin/env node
// scripts/build-player-lines.js
//
// Derives per-player totals from the committed lines files and writes one small
// file per player: data/player-lines/{xx}/{uuid}.json
//
// ⚠️ NO PlayHQ CALL. Every figure here is arithmetic over data already on disk,
// written by fetch-game-lines.js. Runs in a couple of minutes.
//
// WHY A FILE PER PLAYER, when the totals are already in the lines files.
//
// A career table shows the seasons a player appeared in, and the panel needs that
// player's behinds for each. Reading it from the lines files means fetching ~1 MB
// per season in the browser. A per-season rollup keyed by uuid measures 271 KB
// gzipped — the uuids dominate and gzip cannot compress them — so five seasons is
// 1.3 MB to read five rows. One file per player is ~200 bytes and one request,
// and it is the shape data/players/{xx}/{uuid}.json already uses for careers.
//
// ⚠️ IT IS A SEPARATE TREE FROM data/players/, DELIBERATELY. Those files are
// written by fetch-career-stats.js from PlayHQ's own profile route. store.save
// and that writer both write WHOLE files, so a second writer adding a derived
// field to them would have it silently erased on the next career sweep. Derived
// data lives in a tree its own writer owns.
//
// ⚠️ BEHINDS ARE AN UNDERCOUNT AND THE FIELD NAME SAYS SO. `bRec` — behinds
// RECORDED. Measured over 30,942 sides: 27% of the behinds a team kicked were
// credited to a named player, and the best age group managed 44%. Goals are
// near-complete; behinds are what the scorer bothered to attribute. Anything
// rendering this must not call it "behinds".
//
// SHAPE
//   { "uuid": "...", "builtAt": "...", "v": 1,
//     "seasons": { "<seasonId>": { "gp": 13, "g": 5, "bRec": 4, "bGames": 3 } },
//     "total": { "gp": 40, "g": 12, "bRec": 9, "bGames": 7 } }
//
//   `gp` counts games we hold a line for — NOT the player's games played, which
//   PlayHQ reports and the career file already carries. `bGames` is how many of
//   those games credited them at least one behind, which is the only honest
//   denominator for the figure beside it.
//
// ⚠️ WRITE ONLY WHAT CHANGED. 70,000 small files rewritten for a timestamp is
// 70,000 pointless blobs in git history. The comparison ignores `builtAt`, the
// same guard build-career-tops.js needed.
//
// Exit codes: 0 = done. 2 = no lines files. 1 = fatal.
//
// Env: BPL_APPLY (false), BPL_COMMIT, BPL_LIMIT (0 = all).

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./lib/store');

const VERSION = 'build-player-lines v2 2026-09-12 enobufs';
const FV = 1;

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'player-lines');
const APPLY = process.argv.includes('--apply') || process.env.BPL_APPLY === 'true';
const COMMIT = APPLY && process.env.BPL_COMMIT !== 'false';
const LIMIT = Math.max(0, Number(process.env.BPL_LIMIT || 0));

const log = (...a) => console.log(...a);

function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN — nothing will be written'}`);
  log('No PlayHQ call: every figure is arithmetic over committed lines files.\n');

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = core.manifest || [];

  // uuid -> { seasons: { sid: {gp,g,bRec,bGames} } }
  const people = new Map();
  let files = 0, gamesRead = 0, linesRead = 0, anon = 0;

  for (const entry of manifest) {
    const sid = entry && entry.seasonId;
    if (!sid) continue;
    const p = path.join(store.SEASONS_DIR, `${sid}-lines.json.gz`);
    if (!fs.existsSync(p)) continue;
    let f;
    try { f = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')); }
    catch (e) { console.error(`  ⚠️ ${path.basename(p)}: ${e.message} — skipped`); continue; }
    files++;
    const players = f.players || [];
    let g0 = 0, l0 = 0;

    for (const gameId of Object.keys(f.games || {})) {
      const g = f.games[gameId];
      // A stamped negative is an answer about the game, not a line for anybody.
      if (!g || g.n) continue;
      g0++;
      for (const side of ['h', 'a']) {
        for (const row of (g[side] || [])) {
          l0++;
          const who = players[row[0]];
          const uuid = who && who[0];
          // ⚠️ A FILL-IN OR ANONYMOUS PLAYER HAS NO UUID — 1.2% of lines. They
          // have nowhere to be filed and are counted, not silently dropped.
          if (!uuid) { anon++; continue; }
          let rec = people.get(uuid);
          if (!rec) { rec = { seasons: {} }; people.set(uuid, rec); }
          const s = rec.seasons[sid] || (rec.seasons[sid] = { gp: 0, g: 0, bRec: 0, bGames: 0 });
          s.gp++;
          s.g += row[1] || 0;
          const b = row[2] || 0;
          if (b) { s.bRec += b; s.bGames++; }
        }
      }
    }
    gamesRead += g0; linesRead += l0;
    log(`  ${String(entry.compName).padEnd(12)} ${String(g0).padStart(6)} game(s), ${String(l0).padStart(7)} line(s)`);
  }

  if (!files) {
    console.error('\nNo lines file found. Run fetch-game-lines.js first.');
    process.exit(2);
  }
  log(`\n${files} lines file(s); ${gamesRead} game(s); ${linesRead} player line(s); ` +
    `${people.size} distinct player(s); ${anon} line(s) with no uuid`);

  // ── Write ──────────────────────────────────────────────────────────────────
  const canon = (o) => JSON.stringify({ v: o.v, seasons: o.seasons, total: o.total });
  let written = 0, unchanged = 0, considered = 0;
  let totB = 0, totG = 0, withB = 0;

  for (const [uuid, rec] of people) {
    if (LIMIT && considered >= LIMIT) break;
    considered++;
    const total = { gp: 0, g: 0, bRec: 0, bGames: 0 };
    for (const s of Object.values(rec.seasons)) {
      total.gp += s.gp; total.g += s.g; total.bRec += s.bRec; total.bGames += s.bGames;
    }
    totB += total.bRec; totG += total.g;
    if (total.bRec) withB++;

    const out = { uuid, v: FV, seasons: rec.seasons, total, builtAt: new Date().toISOString() };
    // ⚠️ The shard is the first two characters of the uuid, matching
    // data/players/{xx}/. Same players, same split, so the two trees line up.
    const dir = path.join(OUT_DIR, uuid.slice(0, 2));
    const file = path.join(dir, `${uuid}.json`);
    let prev = null;
    if (fs.existsSync(file)) {
      try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { prev = null; }
    }
    if (prev && canon(prev) === canon(out)) { unchanged++; continue; }
    if (!APPLY) { written++; continue; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out));
    written++;
  }

  log(`\nplayers considered ${considered}; ${APPLY ? 'written' : 'would write'} ${written}; unchanged ${unchanged}`);
  log(`goals in stored lines ${totG}; behinds RECORDED ${totB}; ` +
    `${withB} player(s) have at least one`);
  log('⚠️ "recorded" is the whole claim. About 27% of a team\'s behinds reach a named');
  log('   player, so this is a floor. Anything rendering it must say so.');

  if (APPLY && COMMIT && written) {
    try {
      // ⚠️ NEVER READ A FILE LIST FROM GIT HERE. v1 asked for
      // `diff --staged --name-only` and parsed it: 48,687 paths is about 3 MB,
      // execFileSync buffers at 1 MB by default, and the whole run died with
      // ENOBUFS *after* writing every file. Ask for the EXIT CODE instead — it is
      // the same question and it returns nothing.
      execFileSync('git', ['add', '-A', 'data/player-lines/'], { stdio: 'ignore' });
      let staged = false;
      try { execFileSync('git', ['diff', '--staged', '--quiet'], { stdio: 'ignore' }); }
      catch (e) { staged = true; }          // non-zero exit means there IS something
      if (staged) {
        // -q as well: a commit creating 48,687 files prints a line for each.
        execFileSync('git', ['commit', '-q', '-m', `Player line totals: ${written} file(s)`], { stdio: 'ignore' });
        const branch = process.env.GITHUB_REF_NAME || 'main';
        execFileSync('git', ['pull', '--rebase', 'origin', branch], { stdio: 'ignore' });
        execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { stdio: 'ignore' });
        log('pushed.');
      } else log('nothing staged.');
    } catch (e) {
      console.error('push failed:', (e.stderr || e.message || '').toString().split('\n')[0].slice(0, 160));
      process.exit(1);
    }
  }
  if (!APPLY) log('\nDRY RUN — nothing was written.');
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
