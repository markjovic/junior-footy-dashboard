// workers/footy-cron.js — Cloudflare Worker
//
// NOTE: this file lives in the Cloudflare dashboard, not in the repository.
// Committing it to markjovic/junior-footy-dashboard as workers/footy-cron.js is
// worth doing — right now the only copy is inside Cloudflare, it is not version
// controlled, and it is the sole reason anything runs on a schedule.
//
// Four cron triggers (set in the Cloudflare dashboard):
//   10 * * * 7       → Saturday UTC   (Cloudflare: 7=Sat)
//   10 * * * 1       → Sunday UTC     (Cloudflare: 1=Sun)
//   10 * * * 2       → Monday UTC     (Cloudflare: 2=Mon)
//   10 11 * * 4      → Thursday 9pm AEST (Cloudflare: 4=Thu)
//
// Saturday, Sunday and Monday fire EVERY hour at :10 and are filtered below, so
// a new entry on those days needs no Cloudflare change. Thursday is pinned to a
// single hour; a new Thursday entry would need a new trigger.
//
// Worker uses standard JS UTC DOW: 0=Sun, 1=Mon, 6=Sat
// All hours are UTC. AEST = UTC+10.
//
// Requires GITHUB_TOKEN secret (classic PAT with workflow scope).

const REPO       = 'markjovic/junior-footy-dashboard';
const WORKFLOW   = 'fetch-results.yml';
const GITHUB_API = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;

// fetch: 'results' | 'stats' | 'both' | 'fixtures'
// vip:   true = EFNL only, false = all comps
//
// ⚠️ ONE ENTRY PER dow+hour. The dispatcher takes the FIRST match, so a second
// entry sharing a day and hour never fires and gives no error. Check the hour is
// free before adding.
const SCHEDULE = [
  // ── Saturday UTC (JS DOW 6) ─────────────────────────────────
  { dow: 6, hour:  4, fetch: 'results',  vip: true  }, // Sat 2pm AEST
  { dow: 6, hour:  7, fetch: 'results',  vip: true  }, // Sat 5pm AEST
  { dow: 6, hour: 10, fetch: 'results',  vip: true  }, // Sat 8pm AEST
  { dow: 6, hour: 11, fetch: 'fixtures', vip: false }, // Sat 9pm AEST — see FINALS note
  { dow: 6, hour: 13, fetch: 'both',     vip: false }, // Sat 11pm AEST + stats

  // ── Sunday UTC (JS DOW 0) ────────────────────────────────────
  { dow: 0, hour:  1, fetch: 'results',  vip: true  }, // Sun 11am AEST
  { dow: 0, hour:  2, fetch: 'results',  vip: true  }, // Sun 12pm AEST
  { dow: 0, hour:  3, fetch: 'results',  vip: true  }, // Sun 1pm AEST
  { dow: 0, hour:  4, fetch: 'results',  vip: true  }, // Sun 2pm AEST
  { dow: 0, hour:  5, fetch: 'results',  vip: true  }, // Sun 3pm AEST
  { dow: 0, hour:  6, fetch: 'results',  vip: true  }, // Sun 4pm AEST
  { dow: 0, hour:  7, fetch: 'both',     vip: false }, // Sun 5pm AEST + stats VIP
  { dow: 0, hour: 10, fetch: 'results',  vip: true  }, // Sun 8pm AEST
  { dow: 0, hour: 11, fetch: 'fixtures', vip: false }, // Sun 9pm AEST — see FINALS note
  { dow: 0, hour: 13, fetch: 'both',     vip: false }, // Sun 11pm AEST + stats all
  { dow: 0, hour: 17, fetch: 'results',  vip: false }, // Mon 3am AEST (still Sun UTC)
  { dow: 0, hour: 23, fetch: 'results',  vip: true  }, // Mon 9am AEST (still Sun UTC)

  // ── Monday UTC (JS DOW 1) ────────────────────────────────────
  { dow: 1, hour:  2, fetch: 'both',     vip: false }, // Mon 12pm AEST + stats
  { dow: 1, hour: 11, fetch: 'fixtures', vip: false }, // Mon 9pm AEST

  // ── Thursday UTC (JS DOW 4) ──────────────────────────────────
  { dow: 4, hour: 11, fetch: 'fixtures', vip: false }, // Thu 9pm AEST
];

// FINALS note — why the Saturday and Sunday 9pm fixtures runs exist.
//
// The dashboard's finals view decides a team is eliminated when its last played
// game was a loss and it has no fixture after it. That is only sound once the
// NEXT round's fixture has been published and fetched.
//
// Fixtures previously refreshed on Monday and Thursday evenings only. Finals are
// played Saturday and Sunday, so from the final whistle until Monday 9pm the next
// round was not loaded, and a team that lost a qualifying final — which still has
// a preliminary final to come — read as eliminated for up to two days.
//
// Both added at 9pm AEST, after the day's games. Cost is two extra runs a week
// outside finals, when fixtures rarely change.

// Stats run when fetch='both'. The workflow's fetch-stats job runs after
// fetch-results via needs: and checks the fetch input to decide whether to run.
// Fixtures run when fetch='fixtures'. The workflow's fetch-fixtures job handles it.
async function dispatchWorkflow(fetchType, vip, token) {
  const body = JSON.stringify({
    ref: 'main',
    inputs: {
      // These must match the workflow_dispatch inputs in fetch-results.yml
      // exactly. GitHub rejects the whole dispatch with 422 "Unexpected inputs
      // provided" if an input is sent that the workflow does not declare —
      // which is what would have happened had run_migration still been here
      // when it was removed from the workflow on 2026-08-10.
      fetch:    fetchType,
      vip_only: vip ? 'true' : 'false',
    },
  });

  const res = await fetch(GITHUB_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'footy-cron-worker',
    },
    body,
  });
  return res.status;
}

export default {
  async scheduled(event, env, ctx) {
    const now  = new Date(event.scheduledTime);
    const dow  = now.getUTCDay();   // 0=Sun, 1=Mon, 6=Sat
    const hour = now.getUTCHours();

    console.log(`Cron: ${now.toUTCString()} | DOW=${dow} HOUR=${hour}`);

    // Behaviour is unchanged — the first match is dispatched. The filter exists
    // only so a duplicate dow+hour is reported rather than silently ignored.
    const matches = SCHEDULE.filter(s => s.dow === dow && s.hour === hour);
    if (matches.length === 0) {
      console.log('No match — skipping');
      return;
    }
    if (matches.length > 1) {
      console.warn(
        `SCHEDULE has ${matches.length} entries for DOW=${dow} HOUR=${hour}: ` +
        matches.map(m => m.fetch).join(', ') +
        ` — only "${matches[0].fetch}" will run. Move one to a free hour.`
      );
    }

    const match = matches[0];
    console.log(`Dispatching: fetch=${match.fetch} vip=${match.vip}`);
    const status = await dispatchWorkflow(match.fetch, match.vip, env.GITHUB_TOKEN);
    console.log(`GitHub status: ${status}`);

    // 422 means the workflow's declared inputs and this payload have diverged.
    if (status === 422) {
      console.error('422 — fetch-results.yml inputs no longer match this payload.');
    } else if (status !== 204) {
      console.error(`Unexpected status ${status} (204 expected).`);
    }
  },

  async fetch(request, env, ctx) {
    return new Response('footy-cron worker — use cron triggers', { status: 200 });
  },
};
