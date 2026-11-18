#!/usr/bin/env node
// scripts/check-registration.js
//
// Answers one question: why does a given player show no next-season line in the
// dashboard? READ-ONLY — no PlayHQ call, no session, nothing written.
//
// The line in index.html needs FOUR things to be true at once, and when it is
// absent any one of them could be the reason. Guessing which has already cost a
// round trip, so this prints all four verdicts for one player.
//
//   1. a next season exists in the manifest for their competition
//   2. the walk has actually looked at this player (`at` is set)
//   3. the walk found a registration in a TRACKED competition
//   4. that registration's season starts AFTER their current season ENDS
//
// ⚠️ RULE 4 IS THE ONE THAT SURPRISES PEOPLE. A summer competition, a lightning
// premiership or a carnival starting before the 2026 season ends is stored under
// `other`, not `tracked`, and produces no line however real the move is.
//
// Env: CR_PLAYER (name or uuid, required), CR_LIMIT (max matches to print, 5).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('./lib/store');

const VERSION = 'check-registration v1 2026-11-18';

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const WANT = (process.env.CR_PLAYER || '').trim();
const LIMIT = Math.max(1, Number(process.env.CR_LIMIT || 5));

const log = (...a) => console.log(...a);
const die = (m, c = 1) => { console.error(`FATAL: ${m}`); process.exit(c); };
const fold = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/['\u2019`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: no PlayHQ call, nothing written.\n');
  if (!WANT) die('set CR_PLAYER to a player name or uuid.', 2);

  // ── 1. Does a next season exist at all? ────────────────────────────────────
  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId);
  const tracked = manifest.filter(m => m.compName);
  const byId = new Map(manifest.map(m => [m.seasonId, m]));

  log('── 1. seasons in the manifest ──');
  const years = new Map();
  for (const m of tracked) {
    const y = (String(m.compName).match(/\b(20\d\d)\b/) || [])[1] || '?';
    if (!years.has(y)) years.set(y, []);
    years.get(y).push(m);
  }
  for (const y of [...years.keys()].sort()) {
    const ms = years.get(y);
    log(`  ${y}  ${ms.length} season(s): ${ms.map(m => `${m.compName} [${m.state || 'no state'}]`).join(', ')}`);
  }
  const latestYear = Math.max(...[...years.keys()].filter(y => /^\d{4}$/.test(y)).map(Number));
  const nextYear = latestYear + 1;
  const hasNext = years.has(String(nextYear));
  log(`\n  latest season year held: ${latestYear}`);
  if (!hasNext) {
    log(`  ⚠️ NO ${nextYear} SEASON IN THE MANIFEST.`);
    log(`     Until discover-seasons records one, EVERY player shows no next-season`);
    log('     line. That is the feature idle, not the feature broken.');
  } else {
    log(`  ${nextYear} seasons present: ${years.get(String(nextYear)).map(m => m.compName).join(', ')}`);
  }

  // ── 2. Has the walk looked at them? ────────────────────────────────────────
  if (!fs.existsSync(REG_PATH)) {
    die(`${path.relative(ROOT, REG_PATH)} does not exist — walk-registrations has never run.`);
  }
  let reg;
  try { reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8')); }
  catch (e) { die(`could not read the registrations file: ${e.message}`); }

  const people = reg.players || {};
  const meta = reg.meta || {};
  log('\n── 2. the registrations file ──');
  log(`  version ${meta.version}  walkedAt ${meta.walkedAt || '(none)'}  people ${Object.keys(people).length}`);
  if (meta.lastRun) {
    log(`  last run: ${Object.entries(meta.lastRun).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  log(`  cohort seasons: ${(meta.cohortSeasons || []).map(s => (byId.get(s) || {}).compName || s).join(', ')}`);

  // ── 3. Find the player ─────────────────────────────────────────────────────
  const wantFold = fold(WANT);
  const matches = [];
  for (const [uuid, r] of Object.entries(people)) {
    if (uuid === WANT || fold(r.name) === wantFold || fold(r.name).includes(wantFold)) {
      matches.push([uuid, r]);
    }
  }
  log(`\n── 3. "${WANT}" in the cohort ──`);
  if (!matches.length) {
    log('  ⚠️ NOT IN THE COHORT AT ALL.');
    log('     The cohort is every person in the most recent season WITH A PLAYERS FILE');
    log('     of each tracked organisation. A player absent from it is never walked, so');
    log('     no registration can ever be found for them. Check the spelling first; if');
    log('     the name is right, they are not in the latest stored season.');
    process.exit(0);
  }
  log(`  ${matches.length} match(es)${matches.length > LIMIT ? `, showing ${LIMIT}` : ''}`);

  // ── 4. The four conditions, per match ──────────────────────────────────────
  const DAY = 86400000;
  for (const [uuid, r] of matches.slice(0, LIMIT)) {
    log(`\n  ${r.name}  ${uuid}`);
    const from = r.from || {};
    const fromSeason = byId.get(from.seasonId) || {};
    log(`    from        : ${from.compName || '(none)'} · ${from.clubName || '(club not harvested)'}`);
    log(`    checked at  : ${r.at || 'NEVER'}`);
    log(`    next check  : ${r.nextCheck || '(none)'}`);
    if (r.missing) log(`    ⚠️ missing  : ${r.missing}`);

    // (2) walked?
    if (!r.at) {
      log('    ⚠️ THE WALK HAS NEVER LOOKED AT THIS PLAYER.');
      log('       It covers about a seventh of the cohort a day. Nothing can be known');
      log('       about them until it reaches them — this is not a missing registration.');
    } else {
      const age = Math.floor((Date.now() - Date.parse(r.at)) / DAY);
      log(`    last looked : ${age} day(s) ago`);
      if (age > 28) {
        log('    ⚠️ OLDER THAN THE 28-DAY RE-CHECK. A move made since then has not been seen.');
      }
    }

    // (3) tracked registrations
    const tr = r.tracked || [], ot = r.other || [];
    log(`    tracked     : ${tr.length}`);
    for (const t of tr) {
      log(`      ${t.compName} · ${t.clubName || '(no club)'}${t.team ? ` · ${t.team}` : ''} [${t.status}]`);
    }
    log(`    other       : ${ot.length}`);
    for (const o of ot.slice(0, 6)) {
      const days = (o.startDate && o.endDate)
        ? Math.round((Date.parse(o.endDate) - Date.parse(o.startDate)) / DAY) : null;
      log(`      ${o.league || '(league?)'} · ${o.season || '?'} [${o.status}]` +
        `${o.startDate ? ` starts ${o.startDate}` : ''}${days !== null ? ` (${days} days)` : ''}` +
        `${days !== null && days < 60 ? '  ← under 60 days, so it never produces a line' : ''}`);
    }
    if (ot.length > 6) log(`      …and ${ot.length - 6} more`);

    // (4) the after-the-end rule
    const fromEnd = fromSeason.endDate || fromSeason.startDate || '';
    log(`    their season ends: ${fromEnd || '(unknown)'}`);
    if (!tr.length && !ot.length && r.at) {
      log('    ⚠️ PlayHQ RETURNED NO REGISTRATION AT ALL for a season starting after');
      log('       theirs ends. If you can see one on the PlayHQ site, check its START');
      log('       DATE: a season starting on or before the date above is deliberately');
      log('       NOT next season, and is stored under `other` or dropped.');
    }

    // The dashboard's own verdict
    const line = tr.length ? `registered with ${tr[0].clubName || '(club)'}`
      : ot.find(o => o.startDate && o.endDate &&
          (Date.parse(o.endDate) - Date.parse(o.startDate)) / DAY >= 60)
        ? 'now at another league'
        : (hasNext && r.at && from.club) ? 'no registration yet' : '(nothing — line hidden)';
    log(`    ⇒ dashboard would show: ${line}`);
  }

  log('\n── what to do with this ──');
  if (!hasNext) {
    log(`  The ${nextYear} season does not exist in the manifest yet. Run discover-seasons`);
    log('  and re-read this. Everything below that is moot until it does.');
  }
  log('  A move visible on PlayHQ but absent here is one of: the player has not been');
  log('  walked yet, the walk last saw them before the move, or the new season starts');
  log('  before their current one ends and is therefore not "next season" by our rule.');
  log('  The verdicts above say which.');
  process.exit(0);
}

try { main(); }
catch (e) { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); }
