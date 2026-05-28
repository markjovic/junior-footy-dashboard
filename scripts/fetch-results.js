#!/usr/bin/env node
// scripts/fetch-results.js
// Fetches PlayHQ results pages for all grades, parses scores,
// and merges matches into data.json.
//
// Reads:  grades.json  — [{ id, name, slug }] in repo root
//         data.json    — existing data (created if absent)
// Writes: data.json    — updated in repo root (committed by the workflow)

'use strict';

const fs    = require('fs');
const path  = require('path');
const https = require('https');
const http  = require('http');

// jsdom provides a DOM for server-side HTML parsing.
// Installed by the workflow step: npm install jsdom
const { JSDOM } = require('jsdom');

// ─── Config ──────────────────────────────────────────────────────────────────

const GRADES_PATH  = path.resolve(__dirname, '..', 'grades.json');
const DATA_PATH    = path.resolve(__dirname, '..', 'data.json');
const MAX_ROUND    = parseInt(process.env.MAX_ROUND || '22', 10);
const FETCH_DELAY  = parseInt(process.env.FETCH_DELAY_MS || '1200', 10);
const USER_AGENT   = 'Mozilla/5.0 (compatible; EFNL-dashboard-bot/1.0)';

// Base URL for all EFNL PlayHQ competition pages.
// Full round URL: BASE/{slug}/{id}/R{n}
const PLAYHQ_BASE = 'https://www.playhq.com/afl/org/eastern-football-netball-league/2026';

// ─── Name → age/grade derivation ─────────────────────────────────────────────

function parseNameToAgeGrade(name) {
  const m = name.match(/^(U\d+(?:\.\d+)?(?:\s+(?:Girls|Boys))?)\s+([A-D]\d*)$/i);
  if (m) return { age: m[1].trim(), rawGrade: m[2].toUpperCase() };
  return { age: name, rawGrade: '' };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Plain HTTP(S) GET → string (null on non-200, follows one redirect) */
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-AU,en;q=0.9',
      },
      timeout: 20000,
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        console.log(`        [HTTP ${res.statusCode}] ${url}`);
        res.resume();
        return resolve(null);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

/** cleanTeam — mirrors the dashboard's cleanTeam() */
function cleanTeam(name) {
  let n = name.replace(/\s+U\d+\s*/g, ' ').replace(/\s+$/, '').trim();
  const colours = ['Purple','Gold','Blue','Red','Green','White','Black','Silver','Navy','Yellow','Orange','Teal'];
  colours.forEach(c => {
    n = n.replace(new RegExp('\\s+' + c + '\\s*$', 'i'), '').trim();
  });
  return n;
}

// ─── Round page analysis ──────────────────────────────────────────────────────

// Three possible outcomes when fetching a round page:
const ROUND_STATUS = {
  NO_PAGE:   'NO_PAGE',   // non-200, page doesn't exist → end of season
  FUTURE:    'FUTURE',    // games listed but none are Final → not played yet
  COMPLETED: 'COMPLETED', // at least one game is Final → collect results
};

/**
 * analyseRoundPage
 * Returns { status, matches, round }
 *
 * Status logic:
 *   NO_PAGE   — html is null, or no [role="listitem"] blocks found at all
 *   FUTURE    — listitem blocks exist but none contain "Final" → scheduled, not played
 *   COMPLETED — at least one listitem contains "Final" → results available
 *
 * This correctly handles:
 *   - Bye rounds (no listitems on the page) → NO_PAGE, skip and continue
 *   - Grading rounds where girls grades sat out → same
 *   - Future rounds → FUTURE, stop fetching this grade
 *   - Partial results (some finals, some not) → COMPLETED, collect what's there
 */
function analyseRoundPage(html, age, rawGrade) {
  if (!html) return { status: ROUND_STATUS.NO_PAGE, matches: [], round: null };

  let doc;
  try {
    doc = new JSDOM(html).window.document;
  } catch (e) {
    console.error('  JSDOM parse error:', e.message);
    return { status: ROUND_STATUS.NO_PAGE, matches: [], round: null };
  }

  const gameBlocks = Array.from(doc.querySelectorAll('[role="listitem"]'));

  // No game blocks at all → bye round or end of season
  if (!gameBlocks.length) {
    return { status: ROUND_STATUS.NO_PAGE, matches: [], round: null };
  }

  // Check whether any game is marked Final
  const anyFinal = gameBlocks.some(b => /Final/i.test(b.textContent));
  if (!anyFinal) {
    // Games are scheduled but not yet played
    return { status: ROUND_STATUS.FUTURE, matches: [], round: null };
  }

  // At least some finals — parse round number and collect results
  const roundH3 = Array.from(doc.querySelectorAll('h3'))
    .find(h => /Round\s+\d+/i.test(h.textContent));
  const roundMatch = roundH3?.textContent.match(/(\d+)/);
  const round = roundMatch ? parseInt(roundMatch[1], 10) : null;

  // Allow page title to override age/rawGrade (same fallback chain as dashboard)
  const title = doc.querySelector('title')?.textContent || '';
  const titleAge = title.match(/\b(U\d+(?:\.\d+)?(?:\s+(?:Girls|Boys|Womens?|Mens?))?)\b/i);
  if (titleAge) {
    age = titleAge[1]
      .replace(/\s+/g, ' ').trim()
      .split(' ')
      .map((w, i) => i === 0 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }
  const titleGrade = title.match(/U\d+[^-–]*[-–]\s*([A-Z]\d?)/i);
  if (titleGrade) rawGrade = titleGrade[1].toUpperCase();
  const gradeFromURL = html.match(/\/u\d+(?:-(?:girls|boys|womens?|mens?))?-([a-z]\d?)\//i);
  if (!titleGrade && gradeFromURL) rawGrade = gradeFromURL[1].toUpperCase();

  const matches = [];

  gameBlocks.forEach(block => {
    if (!/Final/i.test(block.textContent)) return;

    const logoEls = block.querySelectorAll('[data-testid$="-team-logo"]');
    if (logoEls.length < 2) return;
    const homeName = cleanTeam(logoEls[0].dataset.testid.replace(/-team-logo$/, ''));
    const awayName = cleanTeam(logoEls[1].dataset.testid.replace(/-team-logo$/, ''));

    const allSpans = Array.from(block.querySelectorAll('span'));
    const scorePairs = [];
    for (let i = 0; i < allSpans.length - 1; i++) {
      const a = allSpans[i].textContent.trim();
      const b = allSpans[i + 1].textContent.trim();
      if (/^\d+$/.test(a) && /^\d+\.\d+$/.test(b)) {
        const total = parseInt(a, 10);
        const [g, bh] = b.split('.').map(Number);
        scorePairs.push({ total, g: g || 0, b: bh || 0 });
      }
    }
    if (scorePairs.length < 2) return;

    const vLink = block.querySelector('a[href*="maps.google"]');
    const venue    = vLink ? vLink.textContent.trim().split('/')[0].trim() : '';
    const venueUrl = vLink ? vLink.getAttribute('href') : '';

    const hLogoImg = logoEls[0].querySelector('img');
    const aLogoImg = logoEls[1].querySelector('img');

    const id = `${age}|${rawGrade}|${round}|${[homeName, awayName].sort().join('|')}`;

    matches.push({
      id, age, rawGrade, round,
      home: homeName, away: awayName,
      hScore: scorePairs[0].total, hG: scorePairs[0].g, hB: scorePairs[0].b,
      aScore: scorePairs[1].total, aG: scorePairs[1].g, aB: scorePairs[1].b,
      venue, venueUrl,
      hLogo: hLogoImg?.src || '',
      aLogo: aLogoImg?.src || '',
    });
  });

  return { status: ROUND_STATUS.COMPLETED, matches, round };
}

// ─── Per-grade fetcher ────────────────────────────────────────────────────────

/**
 * fetchGrade
 *
 * - Starts from (highestKnownRound + 1) to skip already-stored data
 * - COMPLETED → collect results, advance to next round
 * - NO_PAGE   → could be a bye; increment round counter and keep trying
 *               (up to MAX_EMPTY_SKIP consecutive empty rounds before giving up)
 * - FUTURE    → round is scheduled but not played yet; stop
 */
async function fetchGrade(grade, knownRounds) {
  const { id, name, slug } = grade;
  const { age, rawGrade } = parseNameToAgeGrade(name);
  const gradeBase = `${PLAYHQ_BASE}/${slug}/${id}`;

  // Start from the round after the last one we already have
  const startRound = (knownRounds.get(`${age}|${rawGrade}`) || 0) + 1;

  if (startRound > MAX_ROUND) {
    console.log(`\n  [${name}] — all rounds already fetched, skipping`);
    return [];
  }

  console.log(`\n  [${name}] — starting from R${startRound}  (${gradeBase})`);

  const allMatches = [];

  // Allow skipping up to this many consecutive rounds with no games
  // before deciding the season is over for this grade.
  // Set to 5 to safely skip the grading-round byes at the start of the season.
  const MAX_EMPTY_SKIP = 5;
  let emptyStreak = 0;

  for (let r = startRound; r <= MAX_ROUND; r++) {
    const url = `${gradeBase}/R${r}`;
    process.stdout.write(`    R${r} ... `);

    let html = null;
    try {
      html = await fetchUrl(url);
    } catch (e) {
      console.log(`FETCH ERROR: ${e.message}`);
      break;
    }

    await sleep(FETCH_DELAY);

    // Verbose diagnostics — shows exactly what the script is receiving
    if (html === null) {
      console.log('HTTP non-200 — no content');
    } else {
      const listitems = (html.match(/role="listitem"/g) || []).length;
      const finals    = (html.match(/Final/gi) || []).length;
      const scripts   = (html.match(/<script/gi) || []).length;
      console.log(`HTTP 200  ${html.length} bytes  listitems=${listitems}  finals=${finals}  scripts=${scripts}`);
      // Snippet around first listitem to confirm real content vs JS shell
      const liIdx = html.indexOf('role="listitem"');
      const snipAt = liIdx > -1 ? Math.max(0, liIdx - 80) : Math.max(0, html.indexOf('<body'));
      console.log(`    snippet[${snipAt}]: ${html.slice(snipAt, snipAt + 400).replace(/\s+/g, ' ')}`);
    }

    const { status, matches } = analyseRoundPage(html, age, rawGrade);

    if (status === ROUND_STATUS.COMPLETED) {
      console.log(`    => COMPLETED: ${matches.length} result(s)`);
      allMatches.push(...matches);
      emptyStreak = 0;

    } else if (status === ROUND_STATUS.NO_PAGE) {
      emptyStreak++;
      console.log(`    => NO_PAGE [${emptyStreak}/${MAX_EMPTY_SKIP}]`);
      if (emptyStreak >= MAX_EMPTY_SKIP) {
        console.log(`    ${MAX_EMPTY_SKIP} consecutive empty rounds — stopping`);
        break;
      }

    } else { // FUTURE
      console.log('    => FUTURE: scheduled but not yet played — stopping');
      break;
    }
  }

  return allMatches;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // 1. Load grades.json
  if (!fs.existsSync(GRADES_PATH)) {
    console.error('grades.json not found at', GRADES_PATH);
    process.exit(1);
  }
  const grades = JSON.parse(fs.readFileSync(GRADES_PATH, 'utf8'));
  console.log(`Loaded ${grades.length} grade(s) from grades.json`);

  // 2. Load existing data.json
  let existing = { matches: [], players: [], roster: {}, gotwFlags: {} };
  if (fs.existsSync(DATA_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
      console.log(`Loaded data.json: ${(existing.matches || []).length} existing match(es)`);
    } catch (e) {
      console.warn('Could not parse existing data.json — starting fresh');
    }
  } else {
    console.log('No existing data.json — will create');
  }

  // 3. Build dedup map and a per-grade "highest known round" map
  const byId = new Map();
  // knownRounds: "age|rawGrade" → highest round number already in data.json
  const knownRounds = new Map();

  (existing.matches || []).forEach(m => {
    byId.set(m.id, m);
    const key = `${m.age}|${m.rawGrade}`;
    knownRounds.set(key, Math.max(knownRounds.get(key) || 0, m.round));
  });

  // 4. Fetch each grade
  let newCount = 0;
  let updatedCount = 0;

  for (const grade of grades) {
    if (!grade.id) {
      console.log(`\n  Skipping "${grade.name}" — missing id`);
      continue;
    }

    const matches = await fetchGrade(grade, knownRounds);

    for (const m of matches) {
      if (byId.has(m.id)) {
        const prev = byId.get(m.id);
        const changed = prev.hScore !== m.hScore || prev.aScore !== m.aScore
                     || prev.hG !== m.hG || prev.hB !== m.hB
                     || prev.aG !== m.aG || prev.aB !== m.aB;
        byId.set(m.id, { ...prev, ...m });
        if (changed) updatedCount++;
      } else {
        byId.set(m.id, m);
        newCount++;
      }
    }
  }

  console.log(`\nMerge: ${newCount} new, ${updatedCount} updated, ${byId.size} total`);

  // 5. Write data.json — preserve all other fields (roster, gotwFlags, players)
  const merged = {
    ...existing,
    matches: Array.from(byId.values())
      .sort((a, b) => a.age.localeCompare(b.age)
                   || a.rawGrade.localeCompare(b.rawGrade)
                   || a.round - b.round),
  };

  fs.writeFileSync(DATA_PATH, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`Wrote data.json`);

  // Exit 2 = no changes (workflow uses this to skip the commit step)
  if (newCount === 0 && updatedCount === 0) {
    console.log('No changes — skipping commit');
    process.exit(2);
  }

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
