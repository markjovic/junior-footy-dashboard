#!/usr/bin/env node
// scripts/probe-registration-date.js

// ⚠️ THE VERSION GOES AT THE TOP, visible without scrolling past the comments.
const VERSION = 'probe-registration-date v1 2026-11-22';

//
// Two questions, both open after today's work.
//
// 1. IS THERE A DATE ON lastInteractedOrganisation?
//
// ⚠️ WITHOUT ONE, RE-SIGNING WITH THE SAME CLUB IS INVISIBLE. The field names a
// club and nothing else. A player who re-registers with the club they already
// played for leaves it UNCHANGED, so we cannot tell "signed up for 2027" from
// "last played there in 2026". Every one of the 1,187 we found was a player
// moving to a DIFFERENT club — the ones staying put are the blind spot, and
// they are the majority.
//
// A timestamp would close it outright: a club unchanged but interacted with
// LAST WEEK is a re-registration.
//
// 2. WHERE IS THE LIST OF WHO REGISTERED?
//
// It must exist — a registration is taken against a season. `participant(id:)`
// answered "Unauthenticated", NOT "no such field", so the data is there and
// requires a login this pipeline does not have.
//
// ⚠️ RECORD WHICH OPERATIONS REQUIRE AUTH, so the boundary is documented and
// nobody re-probes it. This pipeline is anonymous and stays anonymous.
//
// READ-ONLY: nothing is written. About 30 calls.
//
// Env: PD_PROFILE (a uuid), PD_SEASON (a seasonID), PD_PACE_MS (default 900).

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const ROOT = path.resolve(__dirname, '..');
const REG_PATH = path.join(ROOT, 'data', 'registrations.json.gz');
const PACE = Math.max(0, Number(process.env.PD_PACE_MS || 900));

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function tryQuery(label, query, variables) {
  const named = /\bquery\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  let json;
  try { json = await phq.gqlPost(query, variables, named ? named[1] : undefined); }
  catch (e) { log(`    ${label}: call failed — ${e.message}`); return { ok: false }; }
  if (json && json.errors && json.errors.length) {
    const msg = String(json.errors[0].message || '');
    // ⚠️ THREE DIFFERENT ANSWERS, AND THEY MEAN DIFFERENT THINGS.
    const kind = /unauthenticated|unauthorized|forbidden/i.test(msg) ? 'BEHIND A LOGIN'
      : /must have a selection of subfields|Unknown argument|used in position expecting/i.test(msg) ? 'EXISTS, asked wrongly'
      : 'does not exist';
    log(`    ${label}: ${kind} — ${msg.slice(0, 130)}`);
    if (/Did you mean/i.test(msg)) log(`      ↳ ${msg.slice(msg.search(/Did you mean/i)).slice(0, 120)}`);
    return { ok: false, kind, msg };
  }
  const d = JSON.stringify(json && json.data);
  log(`    ${label}: ACCEPTED — ${d.slice(0, 230)}`);
  return { ok: true, data: json.data };
}

async function main() {
  log(`=== ${VERSION} (store ${store.STORE_VERSION}) ===`);
  log('READ-ONLY: nothing is written.\n');

  let profile = (process.env.PD_PROFILE || '').trim();
  if (!profile && fs.existsSync(REG_PATH)) {
    const reg = JSON.parse(zlib.gunzipSync(fs.readFileSync(REG_PATH)).toString('utf8'));
    // Prefer somebody whose lastOrg we already hold, so a date would be checkable
    // against a club we know.
    for (const [u, r] of Object.entries(reg.players || {})) {
      if (r && r.lastOrg && r.lastOrg.id) { profile = u; break; }
    }
    if (!profile) profile = Object.keys(reg.players || {})[0];
  }
  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  const yearOf = (c) => Number((String(c).match(/\b(20\d\d)\b/) || [])[1]) || 0;
  const latest = Math.max(...manifest.map(m => yearOf(m.compName)));
  const season = (process.env.PD_SEASON || '').trim()
    || (manifest.find(m => yearOf(m.compName) === latest) || {}).seasonId;

  log(`profile : ${profile}`);
  log(`season  : ${season}\n`);
  await phq.ensureSession();

  // ── 1. a date anywhere on the profile ──────────────────────────────────────
  log('── 1. is there a DATE on the profile or its last organisation? ──');
  for (const f of ['lastInteractedAt', 'lastInteractedDate', 'lastActiveAt', 'updatedAt',
    'createdAt', 'lastSeenAt', 'lastInteraction { at }', 'lastInteraction { date }',
    'lastInteractedOrganisation { id name updatedAt }',
    'lastInteractedOrganisation { id name lastInteractedAt }',
    'lastInteractedOrganisation { id name season { __typename } }']) {
    await tryQuery(`publicProfile { ${f} }`,
      `query P($id: ID!) { publicProfile(profileID: $id) { id ${f} } }`, { id: profile });
    await sleep(PACE);
  }

  // ── 2. the same on the search result type ──────────────────────────────────
  // DiscoverProfile is a different type from whatever publicProfile returns, and
  // has carried a field the other lacked before.
  log('\n── 2. the same fields on the search result type ──');
  for (const f of ['lastInteractedAt', 'updatedAt', 'createdAt']) {
    await tryQuery(`profileSearch result { ${f} }`,
      `query ProfileSearch($fullName: String!) { profileSearch(fullName: $fullName) ` +
      `{ result { id ${f} } } }`, { fullName: 'john smith' });
    await sleep(PACE);
  }

  // ── 3. the registration operations PlayHQ named ────────────────────────────
  // ⚠️ NAMED BY THE SERVER, not invented: "Did you mean registrationAssert,
  // registrationCheck, or seasonRegistrations?"
  log('\n── 3. registrationCheck / registrationAssert / seasonRegistration ──');
  for (const [label, q, vars] of [
    ['registrationCheck(seasonID:)',
      `query Probe($id: ID!) { registrationCheck(seasonID: $id) { __typename } }`, { id: season }],
    ['registrationCheck(profileID:)',
      `query Probe($id: ID!) { registrationCheck(profileID: $id) { __typename } }`, { id: profile }],
    ['registrationAssert(seasonID:)',
      `query Probe($id: ID!) { registrationAssert(seasonID: $id) { __typename } }`, { id: season }],
    ['seasonRegistration(seasonID:)',
      `query Probe($id: ID!) { seasonRegistration(seasonID: $id) { __typename } }`, { id: season }],
    ['discoverSeasonRegistration(id:)',
      `query Probe($id: ID!) { discoverSeasonRegistration(id: $id) { __typename } }`, { id: season }],
    ['discoverSeasonRegistration(code:)',
      `query Probe($id: ID!) { discoverSeasonRegistration(code: $id) { __typename } }`, { id: season }],
  ]) {
    await tryQuery(label, q, vars);
    await sleep(PACE);
  }

  // ── 4. where exactly is the boundary? ──────────────────────────────────────
  // ⚠️ WRITING DOWN WHICH OPERATIONS NEED A LOGIN. That is the whole purpose of
  // this section — the boundary belongs in the reference so it is not rediscovered.
  log('\n── 4. which operations answer "unauthenticated"? ──');
  for (const [label, q, vars] of [
    ['participant(id:)', `query Probe($id: ID!) { participant(id: $id) { __typename } }`, { id: profile }],
    ['myTeamsParticipants { __typename }',
      `query Probe { myTeamsParticipants { __typename } }`, {}],
    ['profile(id:)', `query Probe($id: ID!) { profile(id: $id) { __typename } }`, { id: profile }],
  ]) {
    await tryQuery(label, q, vars);
    await sleep(PACE);
  }

  log('\n═══ WHAT THIS SAYS ═══');
  log('  A DATE anywhere in section 1 or 2 closes the biggest remaining gap: a');
  log('  player re-signing with the SAME club is invisible today, and they are the');
  log('  majority of registrations.');
  log('');
  log('  ⚠️ "REQUIRES A LOGIN" IS A FINAL ANSWER. This pipeline is anonymous, so');
  log('     an operation that needs one is unavailable to it. Record which, and move on.');
  phq.logSummary('probe-registration-date');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
