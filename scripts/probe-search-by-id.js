#!/usr/bin/env node
// scripts/probe-search-by-id.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-search-by-id v1 2026-11-20';

//
// Can `lastInteractedOrganisation` be reached WITHOUT a name?
//
// ⚠️ WHY THIS MATTERS MORE THAN IT LOOKS. The club a player has signed with for
// next season is currently reachable only through profileSearch, which takes a
// fullName. We hold a uuid for all 40,382 people and a name that PlayHQ may spell
// differently — measured, 4.2% of players do not come back under the name we
// hold at all, and nothing about disambiguation would reach them because we
// already match on uuid.
//
// If the search accepts a uuid, or if the field hangs off an operation that
// takes a profileID, that gap closes to zero and a whole step disappears.
//
// ⚠️ A SEARCH THAT ACCEPTS A UUID MAY STILL NOT BE AN ID LOOKUP. PlayHQ could
// tokenise the uuid and match it as text, returning everybody or nobody. So the
// test is not "did it answer" but "did it return EXACTLY the player whose uuid we
// sent". Anything else is a false positive and is reported as one.
//
// READ-ONLY: nothing is written. Around a dozen calls.
//
// Env: PI_PROFILE (a uuid; defaults to one from our own data), PI_NAME (that
//      player's name, for the control), PI_PACE_MS (default 900).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const PACE = Math.max(0, Number(process.env.PI_PACE_MS || 900));

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

  let uuid = (process.env.PI_PROFILE || '').trim();
  let name = (process.env.PI_NAME || '').trim();

  if (!uuid || !name) {
    if (!fs.existsSync(REG_PATH)) {
      console.error('FATAL: no PI_PROFILE/PI_NAME given and registrations.json.gz is missing.');
      process.exit(1);
    }
    const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
    for (const [u, r] of Object.entries(reg.players || {})) {
      if (r && r.name && r.at) { uuid = uuid || u; name = name || r.name; break; }
    }
  }
  log(`control player: ${name}  ${uuid}\n`);

  await phq.ensureSession();

  // ── 1. the control: the name we know works ─────────────────────────────────
  log('── 1. control — search by the name we hold ──');
  const ctl = await tryQuery('profileSearch(fullName: name)',
    'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) ' +
    '{ result { id firstName lastName lastInteractedOrganisation { id name } } } }',
    { fullName: name });
  await sleep(PACE);
  let controlWorks = false;
  if (ctl.ok) {
    const res = ((ctl.data.profileSearch) || {}).result || [];
    const hit = res.find(p => p.id === uuid);
    controlWorks = !!hit;
    log(`    ${res.length} result(s); our uuid present: ${controlWorks}` +
      (hit && hit.lastInteractedOrganisation ? `  org: ${hit.lastInteractedOrganisation.name}` : ''));
  }
  if (!controlWorks) {
    log('\n  ⚠️ THE CONTROL FAILED. This player is not findable by the name we hold,');
    log('     so nothing below can be compared against a working case. Pick another');
    log('     player with PI_PROFILE and PI_NAME before reading anything into it.');
  }

  // ── 2. the uuid as the search term ─────────────────────────────────────────
  log('\n── 2. does the search accept a uuid as the term? ──');
  for (const term of [uuid, uuid.replace(/-/g, ''), uuid.split('-')[0]]) {
    const r = await tryQuery(`fullName: "${term.slice(0, 20)}${term.length > 20 ? '…' : ''}"`,
      'query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) ' +
      '{ result { id firstName lastName } } }', { fullName: term });
    await sleep(PACE);
    if (!r.ok) continue;
    const res = ((r.data.profileSearch) || {}).result || [];
    const exactly = res.length === 1 && res[0].id === uuid;
    // ⚠️ "IT ANSWERED" IS NOT "IT WORKED". A text search may tokenise the uuid
    // and return everybody, or nobody, and both look like success at a glance.
    log(`      ${res.length} result(s) — ${exactly ? 'EXACTLY our player: this is an id lookup'
      : res.some(p => p.id === uuid) ? 'contains our player among others — treat with suspicion'
      : res.length ? 'results, but NOT our player: it matched as text, useless'
      : 'no results: the search does not take a uuid'}`);
  }

  // ── 3. other arguments on the same operation ───────────────────────────────
  log('\n── 3. does profileSearch take an id argument at all? ──');
  for (const a of ['profileID', 'id', 'profileId', 'ids']) {
    await tryQuery(`profileSearch(${a}:)`,
      `query ProfileSearch($v: ID!) { profileSearch(${a}: $v) { result { id } } }`, { v: uuid });
    await sleep(PACE);
  }

  // ── 4. the field on operations that DO take a profileID ────────────────────
  // ⚠️ THE REAL PRIZE. If lastInteractedOrganisation hangs off publicProfile,
  // which already takes a profileID and which the walk could call, then the
  // search is unnecessary and every one of the 40,382 is reachable by uuid.
  log('\n── 4. is the field reachable from an operation that takes a profileID? ──');
  for (const [label, q] of [
    ['publicProfile { lastInteractedOrganisation }',
      'query P($id: ID!) { publicProfile(profileID: $id) { id lastInteractedOrganisation { id name } } }'],
    ['publicProfile { organisation }',
      'query P($id: ID!) { publicProfile(profileID: $id) { id organisation { id name } } }'],
    ['publicProfileTeams { organisation }',
      'query P($id: ID!) { publicProfileTeams(profileID: $id) { id name organisation { id name } } }'],
    ['publicProfileTeams { season }',
      'query P($id: ID!) { publicProfileTeams(profileID: $id) { id name season { id name startDate endDate } } }'],
  ]) {
    const r = await tryQuery(label, q, { id: uuid });
    await sleep(PACE);
    if (r.ok) log(`      ACCEPTED — ${JSON.stringify(r.data).slice(0, 260)}`);
  }

  log('\n═══ WHAT THIS SAYS ═══');
  log('  Section 4 is the one that matters. If publicProfileTeams can return each');
  log('  team\'s ORGANISATION and SEASON, the walk already has everything it needs');
  log('  and neither the search nor the name is required — the club would come');
  log('  from the operation we ALREADY call, for every player, by uuid.');
  log('  ⚠️ Check the samples, not just the word ACCEPTED. A field that returns');
  log('     null for every row is accepted and useless — `pool` on DiscoverTeam');
  log('     did exactly that and was briefly declared "the route".');
  phq.logSummary('probe-search-by-id');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
