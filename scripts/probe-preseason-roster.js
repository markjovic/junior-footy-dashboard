#!/usr/bin/env node
// scripts/probe-preseason-roster.js
//
// Can we know next season's rosters before a ball is kicked?
//
// THE PRIZE. Knowing which team a player has registered for — especially when
// they have switched clubs over summer — is available nowhere else. PlayHQ
// publishes nothing that lists a team's roster directly; the registration is only
// visible from the PLAYER's side.
//
// THE ROUTE. `publicProfileTeams(profileID)` returns a player's team
// registrations INCLUDING `UPCOMING` ones. Walk last season's players, ask each
// where they are registered now, and the new season's rosters assemble themselves.
//
// ⚠️ EVERYTHING KNOWN ABOUT THIS FIELD WAS MEASURED ON THE basketball-victoria
// TENANT, 2026-08-18. On that tenant:
//   75 of 100 sampled players returned data
//   25 returned "5 NOT_FOUND: failed to find profile"
//   it returned FEWER registrations than storage held (4.1 per player vs 5.2)
// None of that has been re-tested on `afl`, and the two tenants have already
// disagreed once — discoverOrganisation works for a guest here and not there.
//
// ⚠️ AND THE QUERY SHAPE IS A KNOWN TRAP. There is NO `teams { ... }` wrapper;
// the field returns the list directly and DiscoverTeam is a union member needing
// an inline fragment. The wrapper form cost three dispatches in August.
//
// READ-ONLY. No writes, no commits.
//
// USAGE
//   node scripts/probe-preseason-roster.js
//   PROBE_N=200 PROBE_COMP="EFNL 2026" node scripts/probe-preseason-roster.js
//
// Exit codes: 0 = ran. 1 = fatal.

'use strict';

const VERSION = 'probe-preseason-roster v2 2026-09-04 real-manifest';

const fs = require('fs');
const store = require('./lib/store');
const { gqlPost, sleep, logSummary } = require('./lib/playhq');

const N    = Math.max(10, Math.min(500, Number(process.env.PROBE_N || 100)));
const COMP = (process.env.PROBE_COMP || '').trim();

// The shape from playhq_api_reference.md — no wrapper, inline fragment, ID! not
// String!.
const Q = `query PublicProfileTeams($profileID: ID!) {
  publicProfileTeams(profileID: $profileID) {
    ... on DiscoverTeam {
      id
      name
      season { id name status { value } competition { id name } }
      organisation { id name }
    }
  }
}`;

async function main() {
  console.log(`=== ${VERSION} ===`);
  console.log('READ-ONLY — no writes, no commits.\n');

  const data = store.load(COMP ? [COMP] : null, { players: true });
  const players = (data.players || []).filter(p => p.uuid);
  if (!players.length) {
    console.error('No player records with a uuid. Load a season that has players.');
    process.exit(1);
  }

  // One record per person, most recent season first — a player who has left the
  // competition entirely is the interesting case, not a duplicate.
  const seen = new Map();
  for (const p of players) if (!seen.has(p.uuid)) seen.set(p.uuid, p);
  const all = [...seen.values()];

  // Spread across competitions rather than taking the first N, which would all be
  // one grade of one club and say nothing about the rest.
  const byComp = new Map();
  for (const p of all) {
    const k = p.compName || '?';
    if (!byComp.has(k)) byComp.set(k, []);
    byComp.get(k).push(p);
  }
  const per = Math.max(1, Math.floor(N / byComp.size));
  const picks = [];
  for (const arr of byComp.values()) picks.push(...arr.slice(0, per));

  console.log(`${all.length} distinct player(s) in storage across ${byComp.size} competition(s).`);
  console.log(`Sampling ${picks.length}.\n`);

  let answered = 0, notFound = 0, errored = 0;
  let totalTeams = 0;
  const byStatus = new Map();
  const seasonsSeen = new Map();
  const examples = [];
  // ⚠️ THE MANIFEST COMES FROM core.json, NOT FROM store.load().
  //
  // `data.manifest` is empty — store.load() returns matches, players and the
  // cross-organisation keys, not the manifest. v1 read it from there, got an
  // empty Set, and reported EVERY season as one we do not store, including EFNL
  // 2026. The same mistake was found and fixed in build-player-index.js weeks ago
  // and repeated here.
  let knownSeasons = new Set();
  try {
    const core = JSON.parse(fs.readFileSync(store.CORE_PATH, 'utf8'));
    knownSeasons = new Set((core.manifest || []).map(m => m.seasonId).filter(Boolean));
  } catch (e) {
    console.error(`⚠️ Could not read the manifest: ${e.message}`);
    console.error('   Every season will be reported as unknown — do not trust that list.');
  }
  console.log(`Manifest holds ${knownSeasons.size} season(s).\n`);

  for (const p of picks) {
    let json;
    try { json = await gqlPost(Q, { profileID: p.uuid }, 'PublicProfileTeams'); }
    catch (e) { errored++; await sleep(200); continue; }

    if (json.errors && json.errors.length) {
      const msg = String(json.errors[0].message || '');
      if (/NOT_FOUND|failed to find profile/i.test(msg)) notFound++;
      else {
        errored++;
        if (errored <= 2) console.log(`  error: ${msg.slice(0, 140)}`);
      }
      await sleep(200);
      continue;
    }

    const teams = json?.data?.publicProfileTeams || [];
    answered++;
    totalTeams += teams.length;
    for (const t of teams) {
      const st = t.season?.status?.value || '(none)';
      byStatus.set(st, (byStatus.get(st) || 0) + 1);
      const sid = t.season?.id;
      const label = `${t.season?.competition?.name || '?'} ${t.season?.name || '?'} [${st}]`;
      if (sid && !knownSeasons.has(sid)) {
        seasonsSeen.set(label, (seasonsSeen.get(label) || 0) + 1);
        if (examples.length < 10) {
          examples.push(`${p.name}  ${p.compName} ${p.team} → ${t.name} (${label})`);
        }
      }
    }
    await sleep(200);
  }

  console.log('RESULT');
  console.log('─'.repeat(72));
  console.log(`  sampled                        ${picks.length}`);
  console.log(`  answered                       ${answered}`);
  console.log(`  profile not found              ${notFound}`);
  console.log(`  errors                         ${errored}`);
  console.log(`  registrations returned         ${totalTeams}` +
    (answered ? `  (${(totalTeams / answered).toFixed(1)} per player)` : ''));
  console.log('─'.repeat(72));

  if (byStatus.size) {
    console.log('\n  Season status of every registration returned:');
    for (const [k, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(6)}  ${k}`);
    }
  }

  console.log('\nSEASONS WE DO NOT ALREADY STORE');
  console.log('  (a player registered somewhere we do not track — rep teams, other');
  console.log('   leagues, interstate. Each is a season this project has no record of.)');
  if (!seasonsSeen.size) {
    console.log('  None. Every registration is for a season already in the manifest —');
    console.log('  so at this moment there is no future season to discover. Re-run once');
    console.log('  next season opens for registration; that is when this earns its keep.');
  } else {
    for (const [k, n] of [...seasonsSeen].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)} player(s)  ${k}`);
    }
    console.log('\n  Examples — where a player has landed:');
    for (const e of examples) console.log(`    ${e}`);
  }

  console.log('\nVERDICT');
  if (!answered) {
    console.log('  Nothing answered. Either the query shape is wrong for this tenant or');
    console.log('  the stored uuid is not the profileID this field expects — check one');
    console.log('  player against their PlayHQ profile page before concluding.');
  } else {
    const rate = (answered / picks.length * 100).toFixed(0);
    console.log(`  ${rate}% of players answered (basketball-victoria measured 75%).`);
    console.log(`  A full walk of ${all.length} people would be about ${all.length} calls,` +
      ` roughly ${Math.ceil(all.length * 0.25 / 3600)} hour(s) at this rate —`);
    console.log('  which is nothing across an off-season, and gives next season\'s rosters');
    console.log('  before a single fixture is published.');
    if (notFound) {
      console.log('');
      console.log(`  ⚠️ ${notFound} profile(s) not found. On the basketball tenant this was 25%`);
      console.log('     and remains unexplained. It caps coverage — a roster built this way');
      console.log('     is most of a team, not necessarily all of it, and must say so.');
    }
  }

  if (typeof logSummary === 'function') logSummary('probe-preseason-roster');
  console.log(`\n=== ${VERSION} complete — nothing was changed ===`);
}

main().catch(e => {
  console.error('Fatal:', e && e.stack ? e.stack : e);
  process.exit(1);
});
