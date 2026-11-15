// Desk-break server: the Apple Shortcut posts today's step count several times a day (hourly during work hours).
// If you moved less than INACTIVE_STEPS since the previous report, a call is scheduled at a random time
// RANDOM_DELAY_MIN..MAX minutes later (WORK_HOURS only), with a random challenge scaled to how little you moved.
//
//   POST /steps          { "steps": 4210, "date"?, "force"?: true, "challenge"?: "walk"|"squats"|"walk+squats" }
//                        force skips the cooldown; challenge picks the type instead of random (testing / demos)
//   GET  /status         last report, next scheduled call, and today's call attempts (or ?date=YYYY-MM-DD)
//   POST /live-steps     { session_id, steps, started_at }   live count from the StepStream iPhone app (~every 3 s)
//   GET  /live-steps     latest live count, read by the coach agent during a call
//   POST /walk-progress  { room, progress, target, completed }   the coach agent's walk progress for the current call
//   POST /penalty        { "date"?, "attempt_id"? }   retry unpaid penalties (never pays twice for one call)
//   GET  /health         no auth, for checking the server is reachable from the phone
// All routes except /health need Authorization: Bearer <STEPS_TOKEN>.
//
// data/days.json: { "2026-11-15": { steps, goal, attempts: [ { id, call_id, outcome, walk, penalty, notify, ... } ] } }
// data/activity.json: { last: { at, date, steps }, scheduled: { at, challenge, steps_since, ... } | null }
// Outcomes: answered (challenge completed) | failed (answered, challenge not completed) | missed (rang, not answered)
//           | error (never rang: busy line, setup failure). Only missed and failed are charged.
import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { placeCall } from './outbound.mjs';
import { applyPenalty, CHARGEABLE } from './penalty.mjs';
import { DEMO_MODE, describeChallenge, INACTIVE_STEPS, pickChallenge } from './challenge.mjs';

const PORT = Number(process.env.PORT || 3000);
// Inactivity check-ins. DEMO_MODE=1: a 5-20 second delay, work hours ignored, first report of the day counts as inactive.
const [WORK_START, WORK_END] = (process.env.WORK_HOURS || '9-17').split('-').map(Number);
const DELAY_MIN_MS = DEMO_MODE ? 5_000 : 60_000 * Number(process.env.RANDOM_DELAY_MIN || 5);
const DELAY_MAX_MS = DEMO_MODE ? 20_000 : 60_000 * Number(process.env.RANDOM_DELAY_MAX || 30);
const TOKEN = process.env.STEPS_TOKEN;
const CALL_COOLDOWN_MS = 60_000 * Number(process.env.CALL_COOLDOWN_MIN ?? 30);
// Optional daily cap on calls that reach the phone. Unset or 0 = no limit.
const MAX_CALLS_PER_DAY = Number(process.env.MAX_CALLS_PER_DAY || 0) || Infinity;
const maxLabel = Number.isFinite(MAX_CALLS_PER_DAY) ? MAX_CALLS_PER_DAY : 'unlimited';
// A shared line is often busy with another team's call. Each try already waits up to 2 minutes in Chert's queue;
// if the line is still busy, try again every minute, up to BUSY_RETRIES times.
const BUSY_RETRIES = Number(process.env.BUSY_RETRIES ?? 8);
const BUSY_RETRY_DELAY_MS = 60_000;
// After the call ends, wait this long for the agent's last walk report before deciding answered vs failed.
const WALK_REPORT_GRACE_MS = 4000;
// DATA_DIR lets a test run use a throwaway folder instead of ./data.
const DATA_DIR = process.env.DATA_DIR ? pathToFileURL(process.env.DATA_DIR.replace(/\/?$/, '/')) : new URL('./data/', import.meta.url);
const STATE_FILE = new URL('days.json', DATA_DIR);
const ACTIVITY_FILE = new URL('activity.json', DATA_DIR);

if (!TOKEN || TOKEN.length < 16) {
  console.error('STEPS_TOKEN (16+ characters) is missing from .env.local. The server is reachable on your network, so it needs one.');
  process.exit(1);
}

// ---- state ----
const CALL_FIELDS = ['status', 'status_detail', 'outcome', 'call_id', 'error', 'terminal_reason', 'answered_at', 'ended_at', 'penalty', 'notify', 'penalty_error'];

/** Older days.json kept one call per day at the top level; move it into attempts[0] so nothing is lost. */
function migrate(days) {
  for (const [date, rec] of Object.entries(days)) {
    if (rec.attempts) continue;
    rec.attempts = [];
    if (rec.outcome || rec.call_id || rec.penalty) {
      const legacy = { id: `legacy-${date}` };
      for (const f of CALL_FIELDS) if (f in rec) legacy[f] = rec[f];
      legacy.status = 'done';
      rec.attempts.push(legacy);
    }
    for (const f of CALL_FIELDS) delete rec[f];
  }
  return days;
}
async function loadDays() {
  try { return migrate(JSON.parse(await readFile(STATE_FILE, 'utf8'))); } catch { return {}; }
}
let days = await loadDays();
let saving = Promise.resolve();
function saveDays() {
  // Serialize writes so two quick updates can't interleave.
  saving = saving.then(async () => {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = new URL('days.json.tmp', DATA_DIR);
    await writeFile(tmp, JSON.stringify(days, null, 2));
    await rename(tmp, STATE_FILE); // atomic: a crash never leaves half a file
  });
  return saving;
}
function day(date) {
  days[date] ??= { attempts: [] };
  return days[date];
}
async function updateDay(date, fields) {
  Object.assign(day(date), fields, { updated_at: new Date().toISOString() });
  await saveDays();
  return days[date];
}
const findAttempt = (date, id) => day(date).attempts.find(a => a.id === id);
async function updateAttempt(date, id, fields) {
  const a = findAttempt(date, id);
  Object.assign(a, fields, { updated_at: new Date().toISOString() });
  await saveDays();
  return a;
}

/** Attempts that actually reached the phone count toward the daily max and the cooldown; errors do not. */
const reachedPhone = a => ['answered', 'failed', 'missed'].includes(a.outcome);
function callBudget(date) {
  const reached = day(date).attempts.filter(reachedPhone);
  const last = reached.at(-1);
  const lastAt = last ? Date.parse(last.ended_at || last.answered_at || last.started_at) : 0;
  const cooldownUntil = last ? lastAt + CALL_COOLDOWN_MS : 0;
  return { callsToday: reached.length, cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null };
}

let callInProgress = null; // one line answers one call at a time
const roomToAttempt = new Map(); // LiveKit room -> { date, id }, so the agent's walk reports land on the right call

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

async function handleWalkProgress(body) {
  const ref = typeof body.room === 'string' && roomToAttempt.get(body.room);
  // Inbound calls through chert dev have no attempt here: that's fine, nothing to record.
  if (!ref) return { status: 404, body: { error: 'unknown_room' } };
  // Rep challenge progress from the coach (counts come from pose/pose_worker.py): { room, reps: { exercise, target, progress, completed, counter_seen } }
  if (body.reps && typeof body.reps === 'object') {
    const r = body.reps;
    const prev = findAttempt(ref.date, ref.id)?.reps;
    const target = Math.max(1, Math.floor(Number(r.target) || 0));
    const progress = Math.max(Math.floor(Number(r.progress) || 0), prev?.progress ?? 0);
    await updateAttempt(ref.date, ref.id, { reps: {
      exercise: String(r.exercise || 'squat').slice(0, 20), target, progress,
      completed: Boolean(prev?.completed) || r.completed === true || progress >= target,
      counter_seen: Boolean(prev?.counter_seen) || r.counter_seen === true,
      updated_at: new Date().toISOString(),
    } });
    return { status: 200, body: { ok: true } };
  }
  const progress = Math.max(0, Math.floor(Number(body.progress) || 0));
  const target = Math.max(1, Math.floor(Number(body.target) || 0));
  const prev = findAttempt(ref.date, ref.id)?.walk;
  const completed = Boolean(prev?.completed) || body.completed === true || progress >= target; // never goes back to false
  await updateAttempt(ref.date, ref.id, { walk: { target, progress: Math.max(progress, prev?.progress ?? 0), completed, updated_at: new Date().toISOString() } });
  return { status: 200, body: { ok: true } };
}

const penaltyRuns = new Map(); // attempt id -> promise, so two triggers for one call never run at once

/** Runs (or joins) the penalty for one attempt. Only missed/failed attempts are charged; see penalty.mjs. */
function runPenalty(date, id) {
  if (!penaltyRuns.has(id)) {
    const run = applyPenalty({ date, attempt: findAttempt(date, id), get: () => findAttempt(date, id), save: f => updateAttempt(date, id, f) })
      .then(r => { log('penalty', { date, attempt: id, penalty: r.penalty?.status, signature: r.penalty?.signature, notify: r.notify?.status, notify_error: r.notify?.error, skipped: r.skipped, error: r.penalty?.error }); return r; })
      .catch(async err => { log('penalty error', { date, attempt: id, error: err.message }); await updateAttempt(date, id, { penalty_error: err.message }); return { error: err.message }; })
      .finally(() => penaltyRuns.delete(id));
    penaltyRuns.set(id, run);
  }
  return penaltyRuns.get(id);
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

// ---- one accountability call attempt, run in the background so the Shortcut gets an answer at once ----
async function runCall(date, id) {
  const set = fields => updateAttempt(date, id, fields);
  for (let tryNo = 0; ; tryNo++) {
    try {
      const a0 = findAttempt(date, id);
      const result = await placeCall({
        video: true,
        // The coach reads this as ctx.job.metadata: this call's challenge and why it was called.
        agentMetadata: { challenge: a0.challenge, inactivity: { stepsSince: a0.steps_since ?? null, minutesSince: a0.minutes_since ?? null } },
        onEvent: e => {
          if (e.type === 'room_ready') { roomToAttempt.set(e.room, { date, id }); set({ room: e.room }); }
          if (e.type === 'call_created') { set({ call_id: e.call_id, status_detail: 'dialing' }); log('call created', { date, attempt: id, call_id: e.call_id }); }
          if (e.type === 'answered') set({ status_detail: 'in call' });
          if (e.type === 'line_busy_queued') { set({ status_detail: `line busy, waiting in queue (try ${tryNo + 1})` }); log('line busy, queued', { date, attempt: id, queue_id: e.queue_id }); }
          if (e.type === 'line_free') log('line free, dialing', { date, attempt: id });
        },
      });

      // Answered is not enough: this call's challenge (walk and/or reps, saved on the attempt) must be finished.
      let outcome = result.outcome;
      let failReason = null;
      let repsUnverified = false;
      let { walk, reps } = findAttempt(date, id);
      // Answered, but Chert says the call FAILED (not ended by a hang-up): it dropped on our side (e.g. the coach's
      // model session crashed). Not the caller's fault, so no penalty.
      if (outcome === 'answered' && result.status === 'failed') {
        outcome = 'error';
        failReason = 'call_dropped';
      }
      if (outcome === 'answered') {
        const ch = findAttempt(date, id).challenge ?? { walk: 0, reps: 0 };
        const walkDone = () => !(ch.walk > 0) || walk?.completed;
        const done = () => walkDone() && (!(ch.reps > 0) || reps?.completed);
        if (!done()) { await new Promise(r => setTimeout(r, WALK_REPORT_GRACE_MS)); ({ walk, reps } = findAttempt(date, id)); }
        if (!walkDone()) { outcome = 'failed'; failReason = 'walk'; }
        else if (ch.reps > 0 && !reps?.completed) {
          // The rep phase started (the coach reports that at once), but if the pose counter never connected we
          // couldn't count: that's not the caller's fault, so no penalty. Otherwise, unfinished reps = failed.
          if (reps && !reps.counter_seen) repsUnverified = true;
          else { outcome = 'failed'; failReason = 'reps'; }
        }
      }
      log('call finished', { date, attempt: id, outcome, fail_reason: failReason, call_id: result.call_id, terminal_reason: result.terminal_reason,
        walk: `${walk?.progress ?? 0}/${walk?.target ?? '?'}`, reps: reps ? `${reps.progress}/${reps.target} ${reps.exercise}${reps.counter_seen ? '' : ' (no counter)'}` : null });
      const attempt = await set({ status: 'done', status_detail: null, ...result, outcome, fail_reason: failReason, reps_unverified: repsUnverified || undefined,
        walk: walk ?? { progress: 0, completed: false } });
      if (CHARGEABLE.has(outcome)) await runPenalty(date, id);
      return attempt;
    } catch (err) {
      if (err.code === 'line_busy' && tryNo < BUSY_RETRIES) {
        const next = new Date(Date.now() + BUSY_RETRY_DELAY_MS);
        log('line still busy, will retry', { date, attempt: id, retry: tryNo + 1, of: BUSY_RETRIES, at: next.toISOString() });
        await set({ status_detail: `line busy (another team); retry ${tryNo + 1} of ${BUSY_RETRIES} at ${next.toLocaleTimeString()}` });
        await new Promise(r => setTimeout(r, BUSY_RETRY_DELAY_MS));
        continue;
      }
      // Never got as far as ringing the phone: outcome "error", no penalty.
      log('call error', { date, attempt: id, error: err.message });
      return await set({ status: 'done', status_detail: null, outcome: 'error', error: err.message });
    } finally {
      const room = findAttempt(date, id)?.room;
      if (room) setTimeout(() => roomToAttempt.delete(room), 60_000);
    }
  }
}

// ---- routes ----
// ---- inactivity tracking and the scheduled call ----
let activity = { last: null, scheduled: null };
try { activity = { ...activity, ...JSON.parse(await readFile(ACTIVITY_FILE, 'utf8')) }; } catch {}
async function saveActivity() {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = new URL('activity.json.tmp', DATA_DIR);
  await writeFile(tmp, JSON.stringify(activity, null, 2));
  await rename(tmp, ACTIVITY_FILE);
}
const inWorkHours = (d = new Date()) => d.getHours() >= WORK_START && d.getHours() < WORK_END;
let scheduleTimer = null;

function armSchedule() {
  clearTimeout(scheduleTimer);
  const sch = activity.scheduled;
  if (!sch) return;
  scheduleTimer = setTimeout(() => void fireScheduled(), Math.max(0, Date.parse(sch.at) - Date.now()));
}

async function fireScheduled() {
  const sch = activity.scheduled;
  if (!sch) return;
  activity.scheduled = null;
  await saveActivity();
  if (callInProgress) { log('scheduled call skipped: another call is in progress'); return; }
  const date = localDate();
  const attempt = {
    id: `a-${Date.now()}-${randomUUID().slice(0, 6)}`, started_at: new Date().toISOString(), trigger: 'inactivity',
    steps_since: sch.steps_since, minutes_since: sch.minutes_since, challenge: sch.challenge, forced: sch.forced, status: 'calling',
  };
  day(date).attempts.push(attempt);
  await saveDays();
  log('scheduled call firing', { date, attempt: attempt.id, challenge: describeChallenge(sch.challenge) });
  callInProgress = runCall(date, attempt.id).finally(() => { callInProgress = null; });
}

// A call scheduled before a restart still happens; one more than 10 minutes overdue is dropped as stale.
if (activity.scheduled && Date.now() - Date.parse(activity.scheduled.at) > 10 * 60_000) {
  log('dropping stale scheduled call', { call_at: activity.scheduled.at });
  activity.scheduled = null;
  await saveActivity();
}
armSchedule();

async function handleSteps(req, res) {
  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: 'invalid_json' }); }
  const steps = Number(body.steps);
  if (!Number.isFinite(steps) || steps < 0) return send(res, 400, { error: 'steps must be a non-negative number' });
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : localDate();
  const force = body.force === true; // demos: skip the cooldown
  const now = new Date();

  // Steps since the previous report (the Shortcut sends today's running total).
  const prev = activity.last;
  let stepsSince = null;
  let minutesSince = null;
  if (prev && prev.date === date) {
    stepsSince = Math.max(0, steps - prev.steps);
    minutesSince = Math.round((now - Date.parse(prev.at)) / 60_000);
  } else if (DEMO_MODE) {
    stepsSince = 0; // demo: no earlier report today, so this first one counts as inactive
  }
  activity.last = { at: now.toISOString(), date, steps };
  await saveActivity();
  await updateDay(date, { steps });
  log('steps received', { date, steps, steps_since: stepsSince, minutes_since: minutesSince, demo: DEMO_MODE });

  const base = { date, steps, steps_since: stepsSince, minutes_since: minutesSince, inactive_below: INACTIVE_STEPS, demo: DEMO_MODE };
  if (stepsSince == null) return send(res, 200, { status: 'baseline', ...base, note: 'First report today: saved as the starting point.' });
  if (stepsSince >= INACTIVE_STEPS) return send(res, 200, { status: 'active', ...base });
  if (!DEMO_MODE && !inWorkHours(now)) return send(res, 200, { status: 'outside_work_hours', ...base, work_hours: `${WORK_START}-${WORK_END}` });
  if (activity.scheduled) return send(res, 200, { status: 'already_scheduled', ...base, call_at: activity.scheduled.at, challenge: describeChallenge(activity.scheduled.challenge) });
  if (callInProgress) return send(res, 409, { status: 'call_in_progress', ...base });
  const { callsToday, cooldownUntil } = callBudget(date);
  if (callsToday >= MAX_CALLS_PER_DAY) return send(res, 200, { status: 'daily_max_reached', ...base, calls_today: callsToday, max: maxLabel });
  if (cooldownUntil && !force) return send(res, 200, { status: 'cooldown', ...base, next_call_after: cooldownUntil });

  // Inactive: pick the challenge now (scaled to how little they moved) and call at a random time soon.
  // Optional "challenge": "walk" | "squats" | "walk+squats" (testing / demos); otherwise random.
  const challenge = pickChallenge({ stepsSince, kind: typeof body.challenge === 'string' ? body.challenge.toLowerCase() : null });
  const delayMs = Math.round(DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
  // The delay counts from NOW (after any slow saves above), not from when the request arrived, and the timer is
  // armed before saving: a file save stalled by iCloud Desktop sync once made a "13 s" call fire immediately.
  const at = new Date(Date.now() + delayMs).toISOString();
  activity.scheduled = { at, date, steps_since: stepsSince, minutes_since: minutesSince, challenge, forced: force, created_at: new Date().toISOString() };
  armSchedule();
  const saveStart = Date.now();
  await saveActivity();
  // call_at, not "at": log() puts its own timestamp in "at", and a second "at" would overwrite it.
  log('call scheduled', { call_at: at, in_seconds: Math.round(delayMs / 1000), challenge: describeChallenge(challenge), steps_since: stepsSince,
    request_ms: Date.now() - now.getTime(), save_ms: Date.now() - saveStart });
  return send(res, 202, { status: 'scheduled', ...base, call_at: at, in_seconds: Math.round(delayMs / 1000), challenge: describeChallenge(challenge) });
}

async function handlePenaltyRetry(body) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || '') ? body.date : localDate();
  const targets = day(date).attempts.filter(a =>
    CHARGEABLE.has(a.outcome) && (!body.attempt_id || a.id === body.attempt_id) &&
    (a.penalty?.status !== 'confirmed' || a.notify?.status !== 'sent'));
  for (const a of targets) await runPenalty(date, a.id);
  return { date, retried: targets.map(a => a.id), attempts: day(date).attempts.filter(a => CHARGEABLE.has(a.outcome)).map(a => ({ id: a.id, outcome: a.outcome, penalty: a.penalty?.status ?? null, signature: a.penalty?.signature ?? null, notify: a.notify?.status ?? null })) };
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
    if (req.method === 'POST' && url.pathname === '/walk-progress') {
      let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'invalid_json' }); }
      const r = await handleWalkProgress(body);
      return send(res, r.status, r.body);
    }
    if (req.method === 'POST' && url.pathname === '/penalty') {
      let body; try { body = await readJson(req); } catch { return send(res, 400, { error: 'invalid_json' }); }
      return send(res, 200, await handlePenaltyRetry(body));
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      const date = url.searchParams.get('date') || localDate();
      const rec = days[date] ?? { attempts: [] };
      const { callsToday, cooldownUntil } = callBudget(date);
      const sch = activity.scheduled;
      return send(res, 200, {
        date, steps: rec.steps ?? null, calling: Boolean(callInProgress), demo_mode: DEMO_MODE,
        last_report: activity.last,
        next_call: sch ? { at: sch.at, in_seconds: Math.max(0, Math.round((Date.parse(sch.at) - Date.now()) / 1000)), challenge: describeChallenge(sch.challenge), steps_since: sch.steps_since } : null,
        inactive_below: INACTIVE_STEPS, work_hours: DEMO_MODE ? 'ignored (demo)' : `${WORK_START}-${WORK_END}`,
        calls_today: callsToday, max_calls_per_day: maxLabel, cooldown_until: cooldownUntil,
        attempts: rec.attempts,
      });
    }
    send(res, 404, { error: 'not_found' });
  } catch (err) {
    log('request error', { error: err.message });
    if (!res.headersSent) send(res, 500, { error: 'internal' });
  }
});

server.listen(PORT, '0.0.0.0', () => log('step server listening', { port: PORT, demo: DEMO_MODE, inactive_below: INACTIVE_STEPS,
  work_hours: DEMO_MODE ? 'ignored' : `${WORK_START}-${WORK_END}`, delay_s: [DELAY_MIN_MS / 1000, DELAY_MAX_MS / 1000], cooldown_min: CALL_COOLDOWN_MS / 60_000 }));
