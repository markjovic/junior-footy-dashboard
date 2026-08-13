// scripts/probe-ser-logos.js
//
// Answers: why do 566 SER teams have no teamOrg entry?
//
// Fetches one round from a known SER grade, prints the raw logo URLs and
// organisation fields for each team, and tests whether orgCodeFromLogo()
// extracts a code. One API call, ~5 seconds.
//
// Usage: run via probe-ser-logos.yml

'use strict';

const VERSION = 'probe-ser-logos v1 2026-08-13';
console.log(`\n=== ${VERSION} ===`);

const { gqlPost, refreshSession } = require('./lib/playhq');

// SER 2026 season id: 263ca13b
// We need one round id from a SER grade. Fetch the grade list first.
const Q_SEASON = `
query discoverSeason($id: String!) {
  discoverSeason(seasonID: $id) {
    grades {
      id
      name
      rounds {
        id
        number
        isFinalsRound
      }
    }
  }
}`;

const Q_FIXTURE = `
query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      home {
        ... on DiscoverTeam {
          id
          name
          organisation { id }
          logo { sizes { url dimensions { width height } } }
        }
      }
      away {
        ... on DiscoverTeam {
          id
          name
          organisation { id }
          logo { sizes { url dimensions { width height } } }
        }
      }
    }
  }
}`;

function getLogoUrl(logo) {
  if (!logo?.sizes?.length) return '';
  return (logo.sizes.find(s => s.dimensions?.width === 64) || logo.sizes[0]).url;
}

function orgCodeFromLogo(url) {
  const m = String(url || '').match(/\/production\/[a-z]+\/([0-9a-f]{8})-[0-9a-f-]+\//i);
  return m ? m[1].toLowerCase() : '';
}

async function main() {
  await refreshSession();

  // Get the first round of the first SER grade.
  const seasonRes = await gqlPost(Q_SEASON, { id: '263ca13b' });
  const grades = seasonRes?.data?.discoverSeason?.grades || [];
  if (!grades.length) { console.error('No grades returned for SER 2026'); process.exit(1); }

  // Pick the first grade that has at least one round.
  let roundId = null;
  let gradeName = '';
  for (const g of grades) {
    const r = (g.rounds || []).find(r => !r.isFinalsRound);
    if (r) { roundId = r.id; gradeName = g.name; break; }
  }
  if (!roundId) { console.error('No round found'); process.exit(1); }

  console.log(`\nGrade: ${gradeName}`);
  console.log(`Round id: ${roundId}\n`);

  const res = await gqlPost(Q_FIXTURE, { roundID: roundId });
  const games = res?.data?.discoverFixtureByRound?.games || [];
  console.log(`${games.length} game(s) returned\n`);

  let withLogo = 0, withOrg = 0, codeFromLogo = 0, codeFromOrg = 0;

  for (const g of games.slice(0, 5)) {
    for (const [side, team] of [['home', g.home], ['away', g.away]]) {
      if (!team) continue;
      const logoUrl = getLogoUrl(team.logo);
      const orgId   = team.organisation?.id || '';
      const fromLogo = orgCodeFromLogo(logoUrl);
      const fromOrg  = orgId ? orgId.slice(0, 8).toLowerCase() : '';

      if (logoUrl) withLogo++;
      if (orgId)   withOrg++;
      if (fromLogo) codeFromLogo++;
      if (fromOrg)  codeFromOrg++;

      console.log(`${side.padEnd(5)} ${team.name}`);
      console.log(`  logo url  : ${logoUrl || '(none)'}`);
      console.log(`  org id    : ${orgId   || '(none)'}`);
      console.log(`  code/logo : ${fromLogo || '(empty — regex miss)'}`);
      console.log(`  code/org  : ${fromOrg  || '(empty)'}`);
    }
  }

  console.log(`\n─── Summary (first 5 games) ───`);
  console.log(`teams with a logo URL    : ${withLogo}`);
  console.log(`teams with organisation  : ${withOrg}`);
  console.log(`org code from logo regex : ${codeFromLogo}`);
  console.log(`org code from org.id     : ${codeFromOrg}`);

  if (withLogo > 0 && codeFromLogo === 0) {
    console.log('\nDIAGNOSIS: logo URLs present but regex extracts nothing.');
    console.log('The URL format does not match /production/<tenant>/<uuid>/.');
  } else if (withLogo === 0 && withOrg > 0) {
    console.log('\nDIAGNOSIS: no logo URLs returned by the API, but organisation.id is present.');
    console.log('Adding organisation { id } to the query is the correct fix.');
  } else if (withLogo === 0 && withOrg === 0) {
    console.log('\nDIAGNOSIS: neither logo nor organisation returned. PlayHQ data gap for this grade.');
  } else {
    console.log('\nBoth logo and org present — check results-engine.js for why teamOrg is empty.');
  }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
