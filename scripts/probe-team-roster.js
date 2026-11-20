#!/usr/bin/env node
// scripts/probe-team-roster.js
//
// Can discoverTeams tell us WHO is in a 2027 team? READ-ONLY, writes nothing,
// and makes a couple of dozen calls at most.
//
// ⚠️ WHY THIS EXISTS. We ask PlayHQ "what has this player registered for",
// 40,382 times, via publicProfileTeams. For Thomas Arbuckle that returns NOTHING
// — not his 2027 club, not even his 2026 one — while the PlayHQ app shows his new
// team plainly. So the data is published; we are asking down the wrong road.
//
// The right road is probably the one the club trigger already drives down:
// discoverTeams(filter:{seasonID}) returns 217 teams for YJFL 2027 today. It
// selects id, name and organisation and throws the rest away. If a team can also
// return its members, then ONE call per team — a few hundred — replaces 40,382
// profile calls and answers the question directly.
//
// ⚠️ A REJECTED FIELD FAILS THE WHOLE QUERY, so fields are tried ONE AT A TIME
// and never combined until each is known good. walk-registrations.js carries the
// same warning about Q_TEAMS.
//
// ⚠️ A REJECTION THAT NAMES A TYPE IS EVIDENCE THE FIELD EXISTS. "Cannot query
// field X on type DiscoverTeam" means no such field. 'Field "members" of type
// "[Member]" must have a selection of subfields' means it DOES exist and we asked
// for it wrongly — a very different answer, and the log says which.
//
// ⚠️ A 400 IS NOT RETRIED by lib/playhq.js, and its body is RETURNED rather than
// thrown precisely so a probe can read the GraphQL error — including PlayHQ's
// "Did you mean …?" hint. That is why one candidate costs exactly one call.
// Probing eleven field names once cost 36 requests because 400s were retried,
// and that burst is the likeliest cause of the WAF block that followed.
//
// Env: PR_SEASON (a seasonID to probe; default is the first tracked next-season
//      entry in the manifest), PR_TEAM (a teamID, to probe a single team).

'use strict';

const fs = require('fs');
const path = require('path');
const phq = require('./lib/playhq');
const store = require('./lib/store');

const VERSION = 'probe-team-roster v1 2026-11-20';
const ROOT = path.resolve(__dirname, '..');
const log = (...a) => console.log(...a);

const SEASON = (process.env.PR_SEASON || '').trim();
const TEAM = (process.env.PR_TEAM || '').trim();

// Candidate shapes, cheapest and most likely first. Each is ONE call.
const TEAM_FIELD_CANDIDATES = [
  'members { id }',
  'members { person { id } }',
  'players { id }',
  'people { id }',
  'roster { id }',
  'teamMembers { id }',
  'participants { id }',
  'squad { id }',
];

async function tryQuery(label, query, variables) {
  let json;
  // ⚠️ POSITIONAL (query, variables, operationName) — NOT an object. Checked
  // against lib/playhq.js rather than assumed; an object would have been
  // stringified as the query and every probe would have failed identically,
  // which reads exactly like "the field does not exist".
  try { json = await phq.gqlPost(query, variables, 'Probe'); }
  catch (e) { log(`    ${label}: call failed — ${e.message}`); return { ok: false, fatal: true }; }

  if (json && json.errors && json.errors.length) {
    const msg = String(json.errors[0].message || '');
    // The two rejections mean opposite things. Say which.
    const exists = /must have a selection of subfields|Unknown argument|Cannot return null/i.test(msg);
    // PlayHQ suggests the right name on a near miss, and that suggestion is
    // worth more than the whole rest of this probe.
    const hint = /Did you mean/i.test(msg) ? msg.slice(msg.search(/Did you mean/i)) : '';
    if (hint) log(`      ↳ ${hint.slice(0, 120)}`);
    log(`    ${label}: ${exists ? 'FIELD EXISTS, asked wrongly' : 'rejected'} — ${msg.slice(0, 140)}`);
    return { ok: false, exists };
  }
  return { ok: true, data: json && json.data };
}

async function main() {
  log(`=== ${VERSION} ===`);
  log('READ-ONLY: nothing is written. A handful of calls.\n');

  const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
  const manifest = (core.manifest || []).filter(m => m && m.seasonId && m.compName);
  const yearOf = (c) => Number((String(c).match(/\b(20\d\d)\b/) || [])[1]) || 0;
  const latest = Math.max(...manifest.map(m => yearOf(m.compName)));
  const next = manifest.filter(m => yearOf(m.compName) === latest);

  log('── next-season entries in the manifest ──');
  for (const m of next) log(`  ${m.seasonId}  ${m.compName}  [${m.state}]`);

  const seasonID = SEASON || (next[0] && next[0].seasonId);
  if (!seasonID) { console.error('FATAL: no next-season entry and no PR_SEASON given.'); process.exit(1); }
  const seasonName = (next.find(m => m.seasonId === seasonID) || {}).compName || seasonID;
  log(`\nprobing season ${seasonID} (${seasonName})`);

  await phq.ensureSession();

  // ── 1. the query we already run, to confirm the baseline still works ───────
  log('\n── 1. the call the club trigger already makes ──');
  const base = await tryQuery('id + name + organisation',
    `query Probe($seasonID: ID!) { discoverTeams(filter: { seasonID: $seasonID }) {
      id name organisation { id name } } }`, { seasonID });
  if (!base.ok) {
    log('  ⚠️ THE BASELINE ITSELF FAILED. Nothing below can be trusted — fix this first.');
    process.exit(1);
  }
  const teams = (base.data && base.data.discoverTeams) || [];
  log(`  ${teams.length} team(s) returned.`);
  for (const t of teams.slice(0, 3)) log(`    ${t.id}  ${t.name}  (${t.organisation && t.organisation.name})`);
  if (!teams.length) {
    log('  ⚠️ NO TEAMS for this season, so there is nothing to probe. Try another');
    log('     season with PR_SEASON — an ACTIVE season may have teams where an');
    log('     UPCOMING one does not, or the other way round.');
    process.exit(0);
  }

  // ── 2. does a team carry its members? one field at a time ──────────────────
  log('\n── 2. member fields on discoverTeams, ONE AT A TIME ──');
  const accepted = [];
  for (const f of TEAM_FIELD_CANDIDATES) {
    const r = await tryQuery(f,
      `query Probe($seasonID: ID!) { discoverTeams(filter: { seasonID: $seasonID }) { id ${f} } }`,
      { seasonID });
    if (r.ok) {
      accepted.push(f);
      const first = ((r.data && r.data.discoverTeams) || [])[0];
      log(`    ${f}: ACCEPTED — sample: ${JSON.stringify(first).slice(0, 200)}`);
    }
    if (r.fatal) break;
  }

  // ── 3. a single team by id, which may expose more ──────────────────────────
  const teamID = TEAM || teams[0].id;
  log(`\n── 3. one team by id (${teamID}) ──`);
  for (const q of [
    ['discoverTeam(id)', `query Probe($id: ID!) { discoverTeam(id: $id) { id name } }`],
    ['team(id)', `query Probe($id: ID!) { team(id: $id) { id name } }`],
  ]) {
    await tryQuery(q[0], q[1], { id: teamID });
  }

  log('\n═══ WHAT THIS SAYS ═══');
  if (accepted.length) {
    log(`  A team CAN return its members: ${accepted.join(', ')}`);
    log('  That is the route. One call per team — a few hundred — answers who has');
    log('  signed where, directly, instead of 40,382 profile calls that return');
    log('  nothing for players like this one.');
  } else {
    log('  No member field was accepted on discoverTeams.');
    log('  ⚠️ THIS DOES NOT MEAN THE DATA IS UNREACHABLE. It means this operation is');
    log('     not the one the app uses. The next step is to capture the request the');
    log('     PlayHQ app itself makes when it shows a team\'s players, rather than');
    log('     guessing more field names — which is the rule this repo already has.');
  }
  log('\n  Nothing was written. No decision has been made from this run.');
  process.exit(0);
}

main().catch(e => { console.error('Fatal:', e && e.stack ? e.stack : e); process.exit(1); });
