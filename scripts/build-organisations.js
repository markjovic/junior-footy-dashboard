#!/usr/bin/env node
// scripts/build-organisations.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'build-organisations v3 2026-11-20 remember-the-failures';

//
// data/organisations.json — one entry per football organisation: what it runs,
// how long its seasons are, and whether it is a LEAGUE or an EVENT BODY.
//
// ⚠️ REFERENCE DATA IS FETCHED ONCE, NOT PER PLAYER. A season's start and end
// dates are the same for everybody in it. Asking for them on each of 40,382
// walk calls would fetch the same few hundred answers forty thousand times. They
// belong in a repository that is built once and topped up when something new
// appears — which is the whole point of this file.
//
// ⚠️ IT TOPS UP, IT DOES NOT REBUILD. Every run keeps what is already stored and
// fetches only organisations it has never seen, or ones older than PO_MAX_AGE
// days. A full rebuild is PO_FORCE=true and should be rare: an org's season
// history barely changes, and refetching all of them is a few hundred calls
// spent to learn nothing.
//
// ⚠️ A LEAGUE AND AN EVENT BODY ARE TOLD APART BY HISTORY, NOT BY ONE SEASON.
// EFNL records its 2026 season as 364 days and WFNL records the same kind of
// season as 173, because each league sets its own administrative window — the
// span is NOT the games. What separates them is that a league runs ONE long
// season a year, year after year, while a Nines or carnival organiser runs
// several short ones. Measured spread: leagues 173-365 days, events 0-42, with
// nothing in between.
//
// ⚠️ THE SEASON SPAN IS AN ADMINISTRATIVE BOUNDARY, NOT THE GAMES. EFNL 2026
// starts 2025-10-01, months before a ball is kicked, because that is when
// registration opens. Never use these dates to say when someone played.
//
// Env: BO_ORGS (extra org ids to include, comma-separated), BO_MAX_AGE (days
//      before an entry is refreshed, default 90), BO_FORCE (refetch everything),
//      BO_PACE_MS (default 900), BO_LIMIT (max orgs to fetch in one run,
//      default 400), BO_DRY (print, write nothing).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'organisations.json');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const PACE = Math.max(0, Number(process.env.BO_PACE_MS || 900));
const MAX_AGE = Math.max(1, Number(process.env.BO_MAX_AGE || 90));
const LIMIT = Math.max(1, Number(process.env.BO_LIMIT || 400));
const FORCE = /^(1|true|yes)$/i.test(process.env.BO_FORCE || '');
const DRY = /^(1|true|yes)$/i.test(process.env.BO_DRY || '');
const EXTRA = (process.env.BO_ORGS || '').split(',').map(s => s.trim()).filter(Boolean);

const log = (...a) => console.log(...a);
const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ⚠️ Split and use Date.UTC. Never new Date(string).
function dayNum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
}

// discoverCompetitions needs the 8-character organisation CODE and its `seasons`
// field takes its OWN required organisationID. An organisation may legitimately
// return zero competitions — that is an answer, not a failure.
const Q = `query DiscoverCompetitions($id: ID!) {
  discoverCompetitions(organisationID: $id) {
    id
    name
    seasons(organisationID: $id) {
      id
      name
      startDate
      endDate
      status { value }
    }
  }
}`;

// ⚠️ CLASSIFY EACH COMPETITION, THEN THE ORGANISATION — NOT THE OTHER WAY ROUND.
// v1 pooled every season of every competition and took one median. An
// organisation running ONE 153-day league season and TWO 19-day Nines has a
// median of 19, so a real league came out as an "event body" — the exact
// misclassification that would make us drop a genuine transfer. Caught by a
// fixture, not by reading.
function classifyCompetition(c) {
  const lens = [], perYear = {};
  for (const s of (c.seasons || [])) {
    const a = dayNum(s.startDate), b = dayNum(s.endDate);
    if (a !== null && b !== null) lens.push(b - a);
    const y = (String(s.name || '').match(/\b(20\d\d)\b/) || [])[1] || '?';
    perYear[y] = (perYear[y] || 0) + 1;
  }
  lens.sort((a, b) => a - b);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : null;
  const mostPerYear = Math.max(0, ...Object.values(perYear));
  let kind;
  if (median === null) kind = 'unknown';
  else if (median >= 120 && mostPerYear <= 2) kind = 'league';
  else if (median < 60) kind = 'event';
  else kind = 'mixed';
  return { kind, median, mostPerYear, seasons: (c.seasons || []).length,
    years: Object.keys(perYear).filter(y => y !== '?').length };
}

function classify(comps) {
  const each = comps.map(c => ({ id: c.id, name: c.name, ...classifyCompetition(c) }));
  const kinds = new Set(each.map(e => e.kind));
  let kind;
  if (!each.length) kind = 'unknown';
  // ⚠️ ONE REAL LEAGUE MAKES THE ORGANISATION A LEAGUE. A club that also runs a
  // spring Nines has not stopped being a club. Where it runs BOTH, `mixed` is
  // the honest answer — a registration there could be either, and the reader
  // must see that rather than have it forced into a bucket.
  else if (kinds.has('league') && (kinds.has('event') || kinds.has('mixed'))) kind = 'mixed';
  else if (kinds.has('league')) kind = 'league';
  else if (kinds.has('mixed')) kind = 'mixed';
  else if (kinds.has('event')) kind = 'event';
  else kind = 'unknown';

  const leagueComps = each.filter(e => e.kind === 'league');
  const lens = each.map(e => e.median).filter(x => x !== null).sort((a, b) => a - b);
  return {
    kind,
    // The median of the LEAGUE competitions where there are any, because that is
    // the number a reader wants: how long this organisation's real season is.
    median: leagueComps.length
      ? leagueComps.map(e => e.median).sort((a, b) => a - b)[Math.floor(leagueComps.length / 2)]
      : (lens.length ? lens[Math.floor(lens.length / 2)] : null),
    seasons: each.reduce((n, e) => n + e.seasons, 0),
    years: Math.max(0, ...each.map(e => e.years)),
    mostPerYear: Math.max(0, ...each.map(e => e.mostPerYear)),
    perCompetition: each.map(e => ({ id: e.id, name: e.name, kind: e.kind, median: e.median })),
  };
}

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log(`top-up: entries older than ${MAX_AGE} day(s) are refreshed${FORCE ? ' — FORCED, refetching everything' : ''}`);
  if (DRY) log('DRY RUN — nothing will be written.');
  log('');

  // ── What we already have ───────────────────────────────────────────────────
  let storeFile = { version: 1, organisations: {} };
  if (fs.existsSync(OUT_PATH)) {
    try { storeFile = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); }
    catch (e) { log(`  ⚠️ existing file unreadable (${e.message}) — starting fresh`); }
  }
  const have = storeFile.organisations || {};
  log(`already stored: ${Object.keys(have).length} organisation(s)`);

  // ── Every organisation id we know of ───────────────────────────────────────
  const wanted = new Map();   // id -> where we first saw it
  const want = (id, why) => { if (id && !wanted.has(id)) wanted.set(id, why); };

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  for (const id of Object.keys(core.clubs || {})) want(id, 'clubs');
  for (const v of Object.values(core.teamClub || {})) want(v, 'teamClub');
  for (const v of Object.values(core.teamOrg || {})) want(v, 'teamOrg');
  for (const m of (core.manifest || [])) want(m.org, 'manifest');

  if (fs.existsSync(REG_PATH)) {
    try {
      const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
      for (const r of Object.values(reg.players || {})) {
        want((r.from || {}).club, 'registration');
        for (const t of (r.tracked || [])) want(t.club, 'registration');
        // ⚠️ THE NEW ONES COME FROM HERE. An organisation nobody has seen before
        // turns up when a player registers with it, and this is the only place it
        // appears. That is the "add every time a new one is seen" half.
        if (r.lastOrg && r.lastOrg.id) want(r.lastOrg.id, 'lastInteractedOrganisation');
      }
    } catch (e) { log(`  ⚠️ registrations unreadable: ${e.message}`); }
  }
  for (const id of EXTRA) want(id, 'given');

  log(`known organisation ids: ${wanted.size}`);

  // ── Which need fetching ────────────────────────────────────────────────────
  const now = Date.now();
  const stale = (id) => {
    if (FORCE) return true;
    const e = have[id];
    if (!e || !e.at) return true;
    const age = (now - Date.parse(e.at)) / 86400000;
    if (!(age >= 0)) return true;
    // ⚠️ A FAILURE IS REMEMBERED, OR IT IS RETRIED FOREVER. An id that PlayHQ
    // does not recognise failed every run in testing, costing a call a night for
    // nothing. After three attempts it waits out MAX_AGE like anything else —
    // but it is NEVER dropped, because a transient failure and a dead id look
    // identical on any one run.
    if (e.kind === 'failed') {
      // Retry the next run while the count is low — a bad night must not cost an
      // organisation 90 days. Back off only once it has failed repeatedly.
      return (e.failures || 0) < 3 ? true : age > MAX_AGE;
    }
    return age > MAX_AGE;
  };
  const todo = [...wanted.keys()].filter(stale).slice(0, LIMIT);
  const fresh = wanted.size - [...wanted.keys()].filter(stale).length;
  log(`  up to date : ${fresh}`);
  log(`  to fetch   : ${todo.length}${todo.length === LIMIT ? ` (capped at BO_LIMIT ${LIMIT})` : ''}`);
  // ⚠️ THE SUMMARY RUNS ON EVERY PATH. v3 exited here when there was nothing to
  // fetch, so a quiet run printed no repository state at all — including the
  // organisations that have failed repeatedly, which is exactly the thing a
  // reader needs on a quiet run.
  if (!todo.length) {
    log('\nNothing to fetch. Every organisation is current.');
    report(have, []);
    process.exit(0);
  }

  await phq.ensureSession();

  let ok = 0, empty = 0, failed = 0;
  const newly = [];
  for (const id of todo) {
    await sleep(PACE);
    let json;
    try { json = await phq.gqlPost(Q, { id }, 'DiscoverCompetitions'); }
    catch (e) {
      failed++;
      const prev = have[id] || {};
      have[id] = { id, at: new Date().toISOString(), seenAs: wanted.get(id),
        kind: 'failed', error: e.message, failures: (prev.failures || 0) + 1,
        competitions: prev.competitions || [] };
      log(`  ${pad(id, 10)} call failed (${have[id].failures}x) — ${e.message}`);
      continue;
    }
    if (json && json.errors && json.errors.length) {
      failed++;
      const msg = String(json.errors[0].message).slice(0, 110);
      const prev = have[id] || {};
      have[id] = { id, at: new Date().toISOString(), seenAs: wanted.get(id),
        kind: 'failed', error: msg, failures: (prev.failures || 0) + 1,
        competitions: prev.competitions || [] };
      log(`  ${pad(id, 10)} rejected (${have[id].failures}x) — ${msg}`);
      continue;
    }
    const comps = (json.data && json.data.discoverCompetitions) || [];
    const verdict = classify(comps);
    // Zero competitions is documented and legitimate. Stored as such, so it is
    // never refetched as though it had failed.
    if (!comps.length) empty++;
    else ok++;

    const before = have[id];
    have[id] = {
      id,
      at: new Date().toISOString(),
      seenAs: wanted.get(id),
      competitions: comps.map(c => ({
        id: c.id,
        name: c.name,
        seasons: (c.seasons || []).map(s => ({
          id: s.id, name: s.name, startDate: s.startDate, endDate: s.endDate,
          status: s.status && s.status.value,
          days: (dayNum(s.startDate) !== null && dayNum(s.endDate) !== null)
            ? dayNum(s.endDate) - dayNum(s.startDate) : null,
        })),
      })),
      ...verdict,
    };
    if (!before) newly.push(id);
  }

  log(`\nfetched: ${ok} with competitions, ${empty} with none, ${failed} failed`);

  report(have, newly);

  if (DRY) { log('\nDRY RUN — not written.'); process.exit(0); }
  storeFile = { version: 1, builtAt: new Date().toISOString(), organisations: have };
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(storeFile));
  log(`\nWrote ${path.relative(ROOT, OUT_PATH)} (${Math.round(fs.statSync(OUT_PATH).size / 1024)} KB)`);
  phq.logSummary('build-organisations');
  process.exit(0);
}

function report(have, newly) {
  const kinds = {};
  for (const e of Object.values(have)) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
  log('\n── the repository ──');
  log(`  total: ${Object.keys(have).length}`);
  for (const k of Object.keys(kinds).sort()) log(`    ${pad(k, 8)} ${kinds[k]}`);

  const giveUp = Object.values(have).filter(e => e.kind === 'failed' && (e.failures || 0) >= 3);
  if (giveUp.length) {
    log(`\n  ⚠️ ${giveUp.length} organisation(s) have failed 3+ times and are now only retried`);
    log(`     every ${MAX_AGE} days. They are KEPT, not dropped — a dead id and a bad night`);
    log('     look the same on any one run:');
    for (const e of giveUp.slice(0, 6)) log(`     ${pad(e.id, 10)} ${e.failures}x — ${e.error}`);
  }

  const mixed = Object.values(have).filter(e => e.kind === 'mixed').slice(0, 10);
  if (mixed.length) {
    log('\n  ⚠️ MIXED — these run both long and short seasons, so a registration with');
    log('     them cannot be called a transfer or an event on the organisation alone:');
    for (const e of mixed) {
      log(`     ${pad(e.id, 10)} median ${e.median}d — ` +
        (e.perCompetition || []).map(c => `${c.name} [${c.kind}, ${c.median}d]`).join(' + '));
    }
  }
  if (newly.length) {
    log(`\n  ${newly.length} organisation(s) seen for the first time:`);
    for (const id of newly.slice(0, 12)) {
      const e = have[id];
      log(`     ${pad(id, 10)} ${pad(e.kind, 8)} ${(e.competitions[0] || {}).name || '(no competitions)'}  [${e.seenAs}]`);
    }
  }

}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
