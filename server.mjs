// Step-count server: the Apple Shortcut posts today's steps here; if they are under the goal, Chert FaceTimes you.
//
//   POST /steps   { "steps": 4210, "date": "2026-11-15" }   Authorization: Bearer <STEPS_TOKEN>
//   GET  /status  today's record (or ?date=YYYY-MM-DD)       Authorization: Bearer <STEPS_TOKEN>
//   POST /live-steps { "session_id", "steps", "started_at" }  live count from the StepStream iPhone app (~every 3 s)
//   GET  /live-steps  latest live count, read by the coach agent during a call
//   POST /penalty { "date": "2026-11-15" }  retry a missed day's penalty (never pays twice)
//   GET  /health  no auth, for checking the server is reachable from the phone
//
// Every result is saved in data/days.json (one record per date) so the penalty step can read it later.
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { placeCall } from './outbound.mjs';
import { applyPenalty } from './penalty.mjs';

const PORT = Number(process.env.PORT || 3000);
const STEP_GOAL = Number(process.env.STEP_GOAL || 8000);
const TOKEN = process.env.STEPS_TOKEN;
const STATE_FILE = new URL('./data/days.json', import.meta.url);

if (!TOKEN || TOKEN.length < 16) {
  console.error('STEPS_TOKEN (16+ characters) is missing from .env.local. The server is reachable on your network, so it needs one.');
  process.exit(1);
}

// ---- state: { "2026-11-15": { steps, goal, status, outcome, call_id, ... } } ----
async function loadDays() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch { return {}; }
}
let days = await loadDays();
async function saveDays() {
  await mkdir(new URL('./data/', import.meta.url), { recursive: true });
  const tmp = new URL('./data/days.json.tmp', import.meta.url);
  await writeFile(tmp, JSON.stringify(days, null, 2));
  await rename(tmp, STATE_FILE); // atomic: a crash never leaves half a file
}
async function update(date, fields) {
  days[date] = { ...days[date], ...fields, updated_at: new Date().toISOString() };
  await saveDays();
  return days[date];
}

let callInProgress = null; // one line answers one call at a time
// Latest live count from StepStream. In memory only: it matters during a call, not afterwards.
let live = null; // { session_id, steps, started_at, updated_at, date }

function handleLiveSteps(body) {
  const steps = Number(body.steps);
  const sessionId = typeof body.session_id === 'string' ? body.session_id.slice(0, 64) : '';
  if (!sessionId || !Number.isInteger(steps) || steps < 0 || steps > 200_000) return { status: 400, body: { error: 'need session_id and integer steps' } };
  const startedAt = Number.isNaN(Date.parse(body.started_at)) ? new Date().toISOString() : new Date(body.started_at).toISOString();
  // Within one session the count only goes up (pedometer data can arrive out of order).
  const same = live?.session_id === sessionId;
  live = { session_id: sessionId, steps: same ? Math.max(live.steps, steps) : steps, started_at: same ? live.started_at : startedAt, updated_at: new Date().toISOString(), date: localDate() };
  return { status: 200, body: { ok: true, steps: live.steps } };
}
const penaltyRuns = new Map(); // date -> promise, so two triggers for one day never run at once

/** Runs (or joins) the penalty for one day. Only "missed" days are charged; see penalty.mjs. */
function runPenalty(date) {
  if (!penaltyRuns.has(date)) {
    const run = applyPenalty(date, d => days[d], update)
      .then(r => { log('penalty', { date, penalty: r.penalty?.status, signature: r.penalty?.signature, notify: r.notify?.status, notify_error: r.notify?.error, skipped: r.skipped, error: r.penalty?.error }); return r; })
      .catch(async err => { log('penalty error', { date, error: err.message }); await update(date, { penalty_error: err.message }); return { error: err.message }; })
      .finally(() => penaltyRuns.delete(date));
    penaltyRuns.set(date, run);
  }
  return penaltyRuns.get(date);
}

// ---- helpers ----
const localDate = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in this Mac's time zone
function authorized(req) {
  const given = Buffer.from((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 10_000) throw new Error('body too large'); }
  return raw ? JSON.parse(raw) : {};
}
const log = (msg, extra = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), msg, ...extra }));

// ---- the accountability call, run in the background so the Shortcut gets an answer at once ----
async function runCall(date) {
  await update(date, { status: 'calling', outcome: null, call_id: null, error: null });
  try {
    const result = await placeCall({
      video: true,
      onEvent: e => { if (e.type === 'call_created') { update(date, { call_id: e.call_id }); log('call created', { date, call_id: e.call_id }); } },
    });
    log('call finished', { date, outcome: result.outcome, call_id: result.call_id, terminal_reason: result.terminal_reason });
    const record = await update(date, { status: 'done', ...result });
    if (result.outcome === 'missed') await runPenalty(date);
    return record;
  } catch (err) {
    // Never got as far as ringing the phone: outcome "error", no penalty.
    log('call error', { date, error: err.message });
    return await update(date, { status: 'done', outcome: 'error', error: err.message });
  }
}

// ---- routes ----
async function handleSteps(req, res) {
  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: 'invalid_json' }); }
  const steps = Number(body.steps);
  if (!Number.isFinite(steps) || steps < 0) return send(res, 400, { error: 'steps must be a non-negative number' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : localDate();
  const force = body.force === true; // for testing: allow another call on the same day
  const goal = STEP_GOAL;
  const prev = days[date];

  log('steps received', { date, steps, goal });

  if (steps >= goal) {
    await update(date, { steps, goal, status: prev?.status === 'done' ? prev.status : 'goal_met' });
    return send(res, 200, { status: 'goal_met', date, steps, goal });
  }

  // Under goal. One accountability call per day: don't call again after an answered or missed call,
  // but do retry after an "error" (that wasn't the person's fault).
  if (callInProgress) return send(res, 409, { status: 'call_in_progress', date, steps, goal });
  if (!force && prev?.status === 'done' && prev.outcome !== 'error') {
    await update(date, { steps });
    return send(res, 200, { status: 'already_called', date, steps, goal, outcome: prev.outcome });
  }

  await update(date, { steps, goal });
  callInProgress = runCall(date).finally(() => { callInProgress = null; });
  return send(res, 202, { status: 'calling', date, steps, goal, short_by: goal - steps });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });
    if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
    if (req.method === 'POST' && url.pathname === '/steps') return await handleSteps(req, res);
    if (url.pathname === '/live-steps') {
      if (req.method === 'POST') {
        let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'invalid_json' }); }
        const r = handleLiveSteps(body);
        return send(res, r.status, r.body);
      }
      if (req.method === 'GET') return send(res, 200, { live, age_ms: live ? Date.now() - Date.parse(live.updated_at) : null });
    }
    if (req.method === 'POST' && url.pathname === '/penalty') {
      let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'invalid_json' }); }
      const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : localDate();
      if (days[date]?.outcome !== 'missed') return send(res, 409, { error: 'not_missed', date, outcome: days[date]?.outcome ?? null });
      const result = await runPenalty(date);
      return send(res, 200, { date, penalty: days[date].penalty ?? null, notify: days[date].notify ?? null, error: result.error });
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      const date = url.searchParams.get('date') || localDate();
      return send(res, 200, { date, goal: STEP_GOAL, calling: Boolean(callInProgress), record: days[date] ?? null });
    }
    send(res, 404, { error: 'not_found' });
  } catch (err) {
    log('request error', { error: err.message });
    if (!res.headersSent) send(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, '0.0.0.0', () => log('step server listening', { port: PORT, goal: STEP_GOAL }));
