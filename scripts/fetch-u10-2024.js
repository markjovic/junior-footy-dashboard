#!/usr/bin/env node
'use strict';
const https = require('https');

const API_URL = 'https://api.playhq.com/graphql';

const GRADES = [
  { id: 'ce193e34', name: 'U10 Blue' },
  { id: 'edacda03', name: 'U10 Black' },
  { id: '6bc6370d', name: 'U10 Red' },
  { id: 'b8c46cfe', name: 'U10 White' },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function gqlPost(query, variables) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = https.request(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'tenant': 'afl',
        'origin': 'https://www.playhq.com',
      },
      timeout: 30000,
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error(`JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const Q_ROUNDS = `query gradeRounds($gradeID: ID!) {
  discoverGrade(gradeID: $gradeID) {
    rounds { id name number }
  }
}`;

const Q_FIXTURE = `query discoverFixtureByRound($roundID: ID!) {
  discoverFixtureByRound(roundID: $roundID) {
    games {
      home { ... on DiscoverTeam { name } }
      away { ... on DiscoverTeam { name } }
      homeTeamScore { score goals behinds }
      awayTeamScore { score goals behinds }
      status { value }
      date
    }
  }
}`;

async function main() {
  const results = [];

  for (const grade of GRADES) {
    console.log(`Fetching ${grade.name}...`);
    const roundsRes = await gqlPost(Q_ROUNDS, { gradeID: grade.id });
    const rounds = roundsRes?.data?.discoverGrade?.rounds || [];
    await sleep(200);

    for (const round of rounds) {
      const fixRes = await gqlPost(Q_FIXTURE, { roundID: round.id });
      const games = fixRes?.data?.discoverFixtureByRound?.games || [];
      await sleep(200);

      for (const g of games) {
        if (g.status?.value !== 'FINAL') continue;
        results.push({
          grade: grade.name,
          round: round.name,
          date: g.date ? g.date.slice(0,10) : '',
          home: g.home?.name || '',
          away: g.away?.name || '',
          hScore: g.homeTeamScore?.score ?? '',
          hG: g.homeTeamScore?.goals ?? '',
          hB: g.homeTeamScore?.behinds ?? '',
          aScore: g.awayTeamScore?.score ?? '',
          aG: g.awayTeamScore?.goals ?? '',
          aB: g.awayTeamScore?.behinds ?? '',
        });
      }
    }
  }

  // Output as CSV
  const lines = ['Grade,Round,Date,Home,Home Score,Home G,Home B,Away,Away Score,Away G,Away B'];
  for (const r of results) {
    lines.push(`${r.grade},${r.round},${r.date},"${r.home}",${r.hScore},${r.hG},${r.hB},"${r.away}",${r.aScore},${r.aG},${r.aB}`);
  }
  require('fs').writeFileSync('/home/claude/u10-2024-results.csv', lines.join('\n'));
  console.log(`Done — ${results.length} matches written to u10-2024-results.csv`);
}

main().catch(e => { console.error(e); process.exit(1); });
