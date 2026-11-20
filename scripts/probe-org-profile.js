#!/usr/bin/env node
// scripts/probe-org-profile.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-org-profile v2 2026-11-20 season-history-not-one-season';

//
// Given an organisation id, can we learn what KIND of competition it runs?
//
// ⚠️ THIS IS THE MISSING FACT IN THE TRANSFER RULE. `lastInteractedOrganisation`
// is tenant-scoped, so on the `afl` tenant it returns football organisations
// only — a basketball club cannot appear. What it CANNOT tell us is whether the
// destination is a club someone has moved to, or a second registration for a
// spring competition they are playing alongside their normal season.
//
// The deciding fact is the SEASON SHAPE of the destination:
//
//   a standard winter season   April-ish to September-ish, 5+ months
//                              -> a move
//   a short spring/summer comp Nines, carnivals, twilight
//                              -> a second registration, NOT a move
//
// and the STATE, because an interstate winter season is a move of a different
// kind again and worth showing as such.
//
// ⚠️ ENUMERATE NOTHING UNTIL THIS WORKS. The tempting version of this is to
// discover every competition in every state up front. That is a large fetch, and
// it is only worth doing if an org id can be turned into its seasons at all. We
// only ever need the orgs that actually TURN UP in the field, which is a far
// smaller set than the country.
//
// ⚠️ discoverCompetitions NEEDS THE 8-CHARACTER ORGANISATION CODE, not a uuid,
// and its `seasons` field takes its OWN required organisationID. The ids this
// field returns ("70d6161b") are already 8 characters, which is the thing this
// probe is really testing. An organisation may legitimately return zero
// competitions.
//
// READ-ONLY: nothing is written. A handful of calls.
//
// Env: PO_ORGS (comma-separated organisation ids; defaults to a few from our own
//      data plus any given), PO_PACE_MS (default 900).

'use strict';

const fs = require('fs');
const path = require('path');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const PACE = Math.max(0, Number(process.env.PO_PACE_MS || 900));
const GIVEN = (process.env.PO_ORGS || '').split(',').map(s => s.trim()).filter(Boolean);

const log = (...a) => console.log(...a);
const pad = (s, n) => String(s === undefined || s === null ? '' : s).padEnd(n);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ⚠️ Split, never new Date(string).
function dayNum(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
}
function monthOf(s) {
  const m = /^(\d{4})-(\d{2})/.exec(String(s || ''));
  return m ? +m[2] : null;
}

async function tryQuery(label, query, variables) {
  const named = /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  let json;
  try { json = await phq.gqlPost(query, variables, named ? named[1] : undefined); }
  catch (e) { log(`    ${label}: call failed — ${e.message}`); return { ok: false }; }
  if (json && json.errors && json.errors.length) {
    const msg = String(json.errors[0].message || '');
    log(`    ${label}: rejected — ${msg.slice(0, 150)}`);
    return { ok: false, msg };
  }
  return { ok: true, data: json && json.data };
}

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: nothing is written.\n');

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const clubs = core.clubs || {};

  // A handful of our own organisation ids, so there is a known-good control
  // alongside anything handed in.
  const ours = Object.keys(clubs).slice(0, 3);
  const orgs = [...new Set([...GIVEN, ...ours])].slice(0, 12);
  log(`probing ${orgs.length} organisation(s): ${orgs.join(', ')}`);
  log(`  (${GIVEN.length} given, ${ours.length} from our own data as a control)\n`);

  await phq.ensureSession();

  // ── 1. what shape does discoverCompetitions want? ──────────────────────────
  log('── 1. discoverCompetitions, on one organisation ──');
  const first = orgs[0];
  const SHAPES = [
    ['organisationID + seasons(organisationID)',
      `query Probe($id: ID!) { discoverCompetitions(organisationID: $id) { id name
        seasons(organisationID: $id) { id name startDate endDate status { value } } } }`],
    ['organisationID only',
      `query Probe($id: ID!) { discoverCompetitions(organisationID: $id) { id name } }`],
  ];
  let working = null;
  for (const [label, q] of SHAPES) {
    const r = await tryQuery(label, q, { id: first });
    await sleep(PACE);
    if (r.ok) {
      working = q;
      log(`    ${label}: ACCEPTED — ${JSON.stringify(r.data).slice(0, 260)}`);
      break;
    }
  }
  if (!working) {
    log('\n  ⚠️ NEITHER SHAPE WORKED on an organisation id from our own data, so the');
    log('     problem is the query, not the ids the search field returns. Nothing');
    log('     below would mean anything; fix this first.');
    process.exit(0);
  }

  // ── 2. does the org carry a state? ─────────────────────────────────────────
  log('\n── 2. is a STATE reachable for an organisation? ──');
  // ⚠️ ASK THE ORG RECORD FIRST. If it stores the sport, the competition type or
  // a season type outright, the whole length heuristic is unnecessary — a stored
  // fact beats a derived one every time. Introspection is disabled, so this is
  // one call per candidate and worth it.
  for (const f of ['state', 'stateName', 'region { name }', 'address { state }',
    'tenant { id name }', 'type', 'sport', 'sportName', 'organisationType',
    'competitionType', 'level', 'shortName', 'timezone']) {
    await tryQuery(`discoverOrganisation { ${f} }`,
      `query Probe($id: ID!) { discoverOrganisation(organisationID: $id) { id name ${f} } }`,
      { id: first });
    await sleep(PACE);
  }

  // ── 3. profile each organisation ───────────────────────────────────────────
  log('\n── 3. season shape per organisation ──');
  log(`  ${pad('org', 10)} ${pad('competition', 38)} ${pad('season', 10)} ${pad('starts', 11)}${pad('ends', 11)} days  shape`);
  for (const id of orgs) {
    await sleep(PACE);
    const r = await tryQuery(`org ${id}`, working, { id });
    if (!r.ok) continue;
    const comps = (r.data && r.data.discoverCompetitions) || [];
    if (!comps.length) {
      // Documented and legitimate, not a failure.
      log(`  ${pad(id, 10)} (no competitions returned — legitimate for some organisations)`);
      continue;
    }
    for (const c of comps.slice(0, 4)) {
      // ⚠️ EVERY SEASON, NOT THE LAST THREE. One season cannot characterise an
      // organisation: EFNL records 2026 as 2025-10-01 to 2026-09-30 — 365 days,
      // because its span is registration-to-finals — while YJFL records the same
      // kind of season as 140 days. Both are winter leagues. What separates a
      // LEAGUE from an EVENT BODY is the history: a league runs one long season
      // a year, year after year; a Nines organiser runs several short ones.
      const seasons = (c.seasons || []);
      if (!seasons.length) { log(`  ${pad(id, 10)} ${pad(c.name, 38)} (no seasons)`); continue; }
      const lens = seasons.map(x => {
        const a = dayNum(x.startDate), b = dayNum(x.endDate);
        return (a !== null && b !== null) ? (b - a) : null;
      }).filter(x => x !== null).sort((a, b) => a - b);
      const med = lens.length ? lens[Math.floor(lens.length / 2)] : null;
      const perYear = {};
      for (const x of seasons) {
        const y = (String(x.name || '').match(/\b(20\d\d)\b/) || [])[1] || '?';
        perYear[y] = (perYear[y] || 0) + 1;
      }
      const years = Object.keys(perYear).filter(y => y !== '?');
      const mostPerYear = Math.max(0, ...Object.values(perYear));
      log(`  ${pad(id, 10)} ${pad(c.name, 38)} ${seasons.length} season(s), ` +
        `median ${med ?? '?'}d, ${years.length} year(s), up to ${mostPerYear} per year  ` +
        `⇒ ${med === null ? 'unknown' : (med >= 120 && mostPerYear <= 2) ? 'LEAGUE'
          : med < 60 ? 'EVENT BODY' : 'MIXED — read the rows'}`);
      for (const s of seasons.slice(-6)) {
        const a = dayNum(s.startDate), b = dayNum(s.endDate);
        const days = (a !== null && b !== null) ? (b - a) : null;
        const m1 = monthOf(s.startDate);
        // ⚠️ A SHAPE, NOT A VERDICT. Printed so the rule can be written from what
        // the data looks like, rather than a threshold being picked first and
        // defended afterwards — which is how the 60-day fill-in rule went wrong.
        // ⚠️ LENGTH, NOT START MONTH. The obvious rule is "starts in autumn", and
        // it is wrong: EFNL 2027 starts 2026-11-01, because a season's startDate
        // is when REGISTRATION OPENS, not when games begin — already recorded in
        // playhq_api_reference.md, and this classifier reproduced the mistake
        // before being checked against seasons we hold. YJFL 2027 starts
        // 2027-04-18 and EFNL 2027 starts 2026-11-01; both are winter seasons.
        //
        // Length separates them cleanly where the month does not: the measured
        // spread is 0-42 days for Nines and carnivals against 140, 304, 322 and
        // 365 for real seasons, with nothing in between.
        const shape = days === null ? '?'
          : days >= 120 ? 'SEASON'
          : days >= 45 ? 'medium — READ THIS, nothing was expected here'
          : 'short (event)';
        log(`  ${pad(id, 10)} ${pad(c.name, 38)} ${pad(s.name, 10)} ` +
          `${pad(s.startDate || '', 11)}${pad(s.endDate || '', 11)} ${String(days ?? '?').padStart(4)}  ${shape}` +
          `${s.status ? '  [' + s.status.value + ']' : ''}`);
      }
    }
  }

  log('\n═══ WHAT THIS SAYS ═══');
  log('  If the table above shows a usable start date, end date and name for an');
  log('  organisation we did NOT already know, then a destination club can be');
  log('  profiled on demand and the transfer rule becomes:');
  log('');
  log('    same league                        -> a transfer');
  log('    a different org that runs a LEAGUE  -> a transfer (interstate if the state differs)');
  log('    an EVENT BODY                       -> a second registration, NOT a move');
  log('');
  log('  Judged on the organisation\'s HISTORY, not on the one season in question:');
  log('  a league runs one long season a year for years; an event body runs several');
  log('  short ones. That survives EFNL and YJFL recording their spans differently.');
  log('');
  log('  ⚠️ THE LENGTHS ABOVE ARE OBSERVATIONS, NOT A RULE. Anything landing in');
  log('     the "medium" band is the interesting case — the measured spread so far');
  log('     has NOTHING between 42 and 140 days, and a value in that gap would mean');
  log('     the rule needs rewriting rather than its threshold nudging.');
  log('  ⚠️ START MONTH IS NOT USABLE. A season startDate is when registration');
  log('     opens: EFNL 2027 opens 2026-11-01 and is still a winter season.');
  log('  ⚠️ NOTHING IS ENUMERATED YET. Profiling every competition in the country');
  log('     is only worth doing if this works; we need the orgs that turn up, not');
  log('     the country.');
  phq.logSummary('probe-org-profile');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
