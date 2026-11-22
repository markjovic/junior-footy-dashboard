#!/usr/bin/env node
// scripts/probe-org-registrations.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-org-registrations v3 2026-11-22 what-is-in-a-registration';

//
// Can we ask a CLUB who has registered with it, instead of asking 40,382 players
// where they are?
//
// ⚠️ THIS IS THE HIGHEST-VALUE QUESTION LEFT. The walk currently makes one call
// per player — 40,382 at 75/min is about nine hours. But a registration has to
// land somewhere, and the destination is almost always one of the ~195 clubs we
// already hold. If an organisation will list its registered players, the sweep
// collapses from nine hours to minutes.
//
// ⚠️ IT HAS NEVER BEEN PROBED. `discoverTeams` was the wrong question: it asks
// what TEAMS exist, and a registration exists before any team does. This asks
// the organisation directly.
//
// ⚠️ EXPECT IT TO FAIL. A registration is closer to personal data than a team
// sheet, and PlayHQ may simply not publish it by club. A dozen calls to find out
// is cheap, and a clear NO is worth having written down so nobody probes it
// again in six months.
//
// ⚠️ ONE FIELD AT A TIME. A rejected field fails the whole query. A rejection
// naming a TYPE means the field exists and was asked for wrongly; "Cannot query
// field" means it does not exist. PlayHQ also suggests near-misses, and those
// suggestions have been worth more than guessing every time so far.
//
// READ-ONLY: nothing is written. Around 30 calls.
//
// Env: PR_ORG (an organisation code; defaults to one of ours), PR_SEASON (a
//      seasonID to try as a filter), PR_PACE_MS (default 900).

'use strict';

const fs = require('fs');
const path = require('path');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const PACE = Math.max(0, Number(process.env.PR_PACE_MS || 900));

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tryQuery(label, query, variables) {
  const named = /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  let json;
  try { json = await phq.gqlPost(query, variables, named ? named[1] : undefined); }
  catch (e) { log(`    ${label}: call failed — ${e.message}`); return { ok: false }; }
  if (json && json.errors && json.errors.length) {
    const msg = String(json.errors[0].message || '');
    const exists = /must have a selection of subfields|Unknown argument|used in position expecting/i.test(msg);
    log(`    ${label}: ${exists ? 'EXISTS, asked wrongly' : 'rejected'} — ${msg.slice(0, 130)}`);
    if (/Did you mean/i.test(msg)) log(`      ↳ ${msg.slice(msg.search(/Did you mean/i)).slice(0, 120)}`);
    return { ok: false, msg, exists };
  }
  const d = JSON.stringify(json && json.data);
  // ⚠️ ACCEPTED IS NOT POPULATED. `pool` on DiscoverTeam was accepted and null on
  // every team, and was briefly declared "the route".
  const empty = /:(null|\[\])[,}]/.test(d);
  log(`    ${label}: ACCEPTED${empty ? ' but EMPTY' : ''} — ${d.slice(0, 220)}`);
  return { ok: true, data: json.data, empty };
}

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: nothing is written.\n');

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const org = (process.env.PR_ORG || '').trim() || Object.keys(core.clubs || {})[0];
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  const yearOf = (c) => Number((String(c).match(/\b(20\d\d)\b/) || [])[1]) || 0;
  const latest = Math.max(...manifest.map(m => yearOf(m.compName)));
  const season = (process.env.PR_SEASON || '').trim()
    || (manifest.find(m => yearOf(m.compName) === latest) || {}).seasonId;

  log(`organisation : ${org}`);
  log(`season       : ${season}\n`);
  if (!org) { console.error('FATAL: no organisation to probe.'); process.exit(1); }

  await phq.ensureSession();

  // ── 1. fields on the organisation record ───────────────────────────────────
  // discoverOrganisation(code: String!) is confirmed good.
  log('── 1. does the organisation record expose its people? ──');
  for (const f of ['registrations { id }', 'registrations { person { id } }',
    'members { id }', 'participants { id }', 'players { id }', 'people { id }',
    'registeredPlayers { id }', 'roster { id }', 'teams { id name }']) {
    await tryQuery(`discoverOrganisation { ${f} }`,
      `query Probe($v: String!) { discoverOrganisation(code: $v) { id name ${f} } }`, { v: org });
    await sleep(PACE);
  }

  // ── 2. THE OPERATIONS PlayHQ NAMED ITSELF ──────────────────────────────────
  // ⚠️ NOT GUESSES. v1 asked for five invented names and PlayHQ answered each
  // with "Did you mean …?", listing REAL fields on Query. Those suggestions are
  // the schema telling us what exists, and they are worth more than any further
  // guessing. v1 then stopped without trying a single one of them.
  //
  //   organisationRegistrations      suggested for publicOrganisationRegistrations
  //   seasonRegistrations            suggested for registrations
  //   discoverSeasonRegistration     suggested for discoverRegistrations
  //   participant, myTeamsParticipants, duplicateProfiles
  log('\n── 2a. the operations PlayHQ named in its own suggestions ──');
  for (const [label, q, vars] of [
    ['organisationRegistrations(organisationID:)',
      `query Probe($id: ID!) { organisationRegistrations(organisationID: $id) { id } }`, { id: org }],
    ['organisationRegistrations(organisationID: String)',
      `query Probe($id: String!) { organisationRegistrations(organisationID: $id) { id } }`, { id: org }],
    ['organisationRegistrations() no args',
      `query Probe { organisationRegistrations { id } }`, {}],
    ['seasonRegistrations(seasonID: String)',
      `query Probe($id: String!) { seasonRegistrations(seasonID: $id) { id } }`, { id: season }],
    ['seasonRegistrations(seasonID: ID)',
      `query Probe($id: ID!) { seasonRegistrations(seasonID: $id) { id } }`, { id: season }],
    ['discoverSeasonRegistration(seasonID: String)',
      `query Probe($id: String!) { discoverSeasonRegistration(seasonID: $id) { id } }`, { id: season }],
    ['participant(id:)',
      `query Probe($id: ID!) { participant(id: $id) { id } }`, { id: org }],
    ['myTeamsParticipants',
      `query Probe { myTeamsParticipants { id } }`, {}],
  ]) {
    await tryQuery(label, q, vars);
    await sleep(PACE);
  }

  // ── 2c. WHAT IS INSIDE A REGISTRATION ──────────────────────────────────────
  // ⚠️ THIS IS THE WHOLE QUESTION NOW. seasonRegistrations(seasonID: ID!) returns
  // a populated list for a season with NO TEAMS PICKED — exactly the state the
  // per-player walk cannot see. If a record carries the PERSON and the
  // ORGANISATION, the walk stops being a walk: a handful of season calls replace
  // 40,382 profile calls, and the rate ceiling stops mattering at all.
  //
  // ⚠️ AN ID ALONE IS USELESS. The list came back as bare ids. If that is all a
  // registration exposes, we would still need a lookup per registration and
  // nothing is saved. One field at a time, because a rejected field fails the
  // whole query.
  log('\n── 2c. what does a SeasonRegistration actually hold? ──');
  for (const f of ['profile { id firstName lastName }', 'person { id }', 'player { id }',
    'participant { id }', 'organisation { id name }', 'club { id name }',
    'team { id name }', 'status', 'status { value }', 'createdAt', 'registeredAt',
    'season { id name }', 'type', 'role']) {
    await tryQuery(`seasonRegistrations { ${f} }`,
      `query Probe($id: ID!) { seasonRegistrations(seasonID: $id) { id ${f} } }`, { id: season });
    await sleep(PACE);
  }

  // ── 2d. the organisation route, with the argument PlayHQ named ─────────────
  // ⚠️ `code: ID!` CAME FROM PlayHQ'S OWN ERROR, not from guessing: "argument
  // \"code\" of type \"ID!\" is required". v2 never tried it.
  log('\n── 2d. organisationRegistrations(code: ID!) ──');
  for (const f of ['id', 'id profile { id }', 'id organisation { id name }',
    'id season { id name }']) {
    await tryQuery(`organisationRegistrations { ${f} }`,
      `query Probe($v: ID!) { organisationRegistrations(code: $v) { ${f} } }`, { v: org });
    await sleep(PACE);
  }

  log('\n── 2b. the invented names, kept so the NO stays recorded ──');
  for (const [label, q, vars] of [
    ['discoverRegistrations(organisationID:)',
      `query Probe($id: ID!) { discoverRegistrations(organisationID: $id) { id } }`, { id: org }],
    ['registrations(organisationID:)',
      `query Probe($id: ID!) { registrations(organisationID: $id) { id } }`, { id: org }],
    ['publicOrganisationRegistrations(organisationID:)',
      `query Probe($id: ID!) { publicOrganisationRegistrations(organisationID: $id) { id } }`, { id: org }],
    ['discoverParticipants(organisationID:)',
      `query Probe($id: ID!) { discoverParticipants(organisationID: $id) { id } }`, { id: org }],
    ['discoverProfiles(organisationID:)',
      `query Probe($id: ID!) { discoverProfiles(organisationID: $id) { id } }`, { id: org }],
  ]) {
    await tryQuery(label, q, vars);
    await sleep(PACE);
  }

  // ── 3. the season side ─────────────────────────────────────────────────────
  // ⚠️ A SEASON KNOWS ITS REGISTRATIONS even before teams exist — that is how a
  // club picks teams from a list. Whether it PUBLISHES them is the question.
  log('\n── 3. does a season expose its registrations? ──');
  // ⚠️ String!, NOT ID!. v1 ran all five of these with an ID! variable and every
  // one failed on the VARIABLE before reaching the field — so section 3 measured
  // nothing at all. Same mistake as probe-org-profile v2, one script later.
  for (const f of ['registrations { id }', 'participants { id }', 'members { id }',
    'players { id }', 'teams { id name }', 'competition { id name }', 'status { value }']) {
    await tryQuery(`discoverSeason { ${f} }`,
      `query Probe($id: String!) { discoverSeason(seasonID: $id) { id name ${f} } }`, { id: season });
    await sleep(PACE);
  }

  // ── 4. the argument shape, if the field exists but the argument is wrong ────
  log('\n── 4. confirmed: discoverSeason(seasonID: String!) ──');
  await tryQuery('discoverSeason(seasonID: String)',
    `query Probe($v: String!) { discoverSeason(seasonID: $v) { id name } }`, { v: season });

  log('\n═══ WHAT THIS SAYS ═══');
  log('  seasonRegistrations(seasonID: ID!) is CONFIRMED to return a populated');
  log('  list for a season with no teams. The question section 2c answers is');
  log('  whether a record names the PERSON and the CLUB.');
  log('    both       -> the walk is replaceable, outright');
  log('    person only-> still need the club from somewhere, but far fewer calls');
  log('    ids only   -> a lookup per registration, and nothing is saved');
  log('');
  log('  If ANY of the above returned a populated list of people, the walk can be');
  log('  replaced: ~195 organisation calls instead of 40,382 player calls, and a');
  log('  nine-hour sweep becomes minutes.');
  log('');
  log('  ⚠️ IF EVERYTHING WAS REJECTED, that is a real answer and worth writing');
  log('     into playhq_api_reference.md: registrations are not published by club,');
  log('     and the per-player route is the only one. Nobody should probe this');
  log('     again without new information.');
  log('  ⚠️ "ACCEPTED but EMPTY" IS NOT A YES. Check the samples.');
  phq.logSummary('probe-org-registrations');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
