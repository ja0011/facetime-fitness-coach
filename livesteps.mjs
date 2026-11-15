// Live walking challenge: read StepStream's live count from server.mjs and have the coach announce progress.
//
// Why polling: StepStream posts to server.mjs, which runs on this same Mac, so a localhost GET every 2 s is the
// simplest path with the fewest moving parts (a LiveKit data message would need the iPhone app to join the room).
//
// Why the coach waits: announcements are generateReply() calls. Speaking over the caller or over itself makes a
// realtime model cut off or stack replies, so we only announce when both sides are quiet, and the latest count wins.

const POLL_MS = 2000;
const STALE_MS = 10_000; // no update this long = the app is not sending
const START_DELAY_MS = 12_000; // let the greeting and the challenge intro finish first
const ANNOUNCE_EVERY = Number(process.env.WALK_ANNOUNCE_EVERY || 50); // steps between progress callouts
const MIN_GAP_MS = 15_000; // never call out progress more often than this
const NUDGE_EVERY_MS = 45_000; // repeat "open StepStream" at most this often

export const WALK_TARGET = Number(process.env.WALK_TARGET || 300);

/**
 * @param {{ session: any, callStart: number, log?: (msg: string, extra?: object) => void }} opts
 * @returns {() => void} stop
 */
export function startWalkChallenge({ session, callStart, log = () => {} }) {
  const url = `${process.env.LIVE_STEPS_URL || `http://127.0.0.1:${process.env.PORT || 3000}`}/live-steps`;
  const token = process.env.STEPS_TOKEN;
  let stopped = false;
  let timer;

  let baseline = null; // { session_id, steps } the count when the challenge started for this StepStream session
  let lastAnnouncedStep = 0;
  let lastAnnounceAt = 0;
  let lastNudgeAt = 0;
  let finished = false;
  let wasStale = true;

  const quiet = () => session.agentState !== 'speaking' && session.agentState !== 'thinking' && session.userState !== 'speaking';

  function say(instructions) {
    try { session.generateReply({ instructions }); } catch (err) { log('walk: reply failed', { error: err?.message }); }
  }

  async function read() {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`live-steps HTTP ${res.status}`);
    return res.json();
  }

  async function tick() {
    if (stopped) return;
    let data = null;
    try { data = await read(); } catch (err) { log('walk: server unreachable', { error: err.message }); }
    const liveRec = data?.live;
    const fresh = liveRec && data.age_ms != null && data.age_ms < STALE_MS;
    const now = Date.now();

    if (!fresh) {
      wasStale = true;
      if (!finished && now - lastNudgeAt > NUDGE_EVERY_MS && quiet()) {
        lastNudgeAt = now;
        log('walk: no live steps, nudging');
        say('In one short sentence, tell the caller you are not getting their steps yet: they should open the StepStream app, tap Start, then come back to FaceTime. Do not make up a step count.');
      }
      return;
    }

    // A StepStream session started during this call counts from zero; an older one counts from when we first saw it.
    if (baseline?.session_id !== liveRec.session_id) {
      const startedDuringCall = Date.parse(liveRec.started_at) >= callStart;
      baseline = { session_id: liveRec.session_id, steps: startedDuringCall ? 0 : liveRec.steps };
      lastAnnouncedStep = 0;
      log('walk: tracking session', { started_during_call: startedDuringCall });
    }
    const progress = Math.max(0, liveRec.steps - baseline.steps);
    const left = Math.max(0, WALK_TARGET - progress);

    if (!finished && progress >= WALK_TARGET) {
      if (!quiet()) return; // try again on the next poll
      finished = true;
      log('walk: target reached', { progress });
      say(`Celebrate briefly: the caller just hit ${progress} steps and completed the ${WALK_TARGET}-step walking challenge. Then wrap up warmly in one sentence. Use exactly these numbers.`);
      return;
    }
    if (finished) return;

    if (wasStale && quiet()) {
      wasStale = false;
      lastAnnounceAt = now;
      lastAnnouncedStep = progress;
      say(`In one short sentence, say you are getting their steps now: ${progress} so far, ${left} to go. Use exactly these numbers.`);
      return;
    }
    const due = progress - lastAnnouncedStep >= ANNOUNCE_EVERY && now - lastAnnounceAt >= MIN_GAP_MS;
    if (due && quiet()) {
      lastAnnounceAt = now;
      lastAnnouncedStep = progress;
      say(`Give a quick progress callout in under ten words, like "${progress} steps... ${left} to go!" Use exactly these numbers.`);
    }
  }

  if (!token) { log('walk: STEPS_TOKEN missing from .env.local; live steps disabled'); return () => {}; }
  const loop = async () => { await tick(); if (!stopped) timer = setTimeout(loop, POLL_MS); };
  timer = setTimeout(loop, START_DELAY_MS);
  return () => { stopped = true; clearTimeout(timer); };
}
