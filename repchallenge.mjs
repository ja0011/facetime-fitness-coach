// Rep challenge, after the walk: the pose worker (pose/pose_worker.py) counts reps from the caller's camera and sends
// LiveKit data messages on topic "chert.reps"; the coach calls out each new rep and reports progress to server.mjs,
// which decides "answered" vs "failed" when the call ends.
//
// Why data messages: the pose worker and this agent are already in the same LiveKit room, so counts arrive in real
// time with nothing else in the path (no HTTP polling, no extra server hop).
import { RoomEvent } from '@livekit/rtc-node';

export const REPS_TARGET = Number(process.env.REPS_TARGET ?? 10); // 0 turns the rep challenge off
export const REPS_EXERCISE = ['squat', 'pushup', 'jumping_jack'].includes(process.env.REPS_EXERCISE) ? process.env.REPS_EXERCISE : 'squat';
export const EXERCISE_WORDS = { squat: 'squats', pushup: 'push-ups', jumping_jack: 'jumping jacks' };
const TOPIC = 'chert.reps';
const CALLOUT_MIN_GAP_MS = 1000 * Number(process.env.REP_CALLOUT_MIN_GAP_S || 1.2);
const NOT_VISIBLE_NUDGE_MS = 6000; // body out of frame this long -> "step back so I can see you"
const NUDGE_EVERY_MS = 20_000;
const NO_COUNTER_MS = 12_000; // no message from the pose worker this long after the start -> it isn't running

/**
 * Listens for pose counts from the moment the room is joined (so the baseline is known), but only coaches once
 * start() is called after the walk.
 * @param {{ room: any, session: any, report: (reps: object) => Promise<void> | void, log?: Function }} opts
 */
export function createRepChallenge({ room, session, report, target = REPS_TARGET, exercise = REPS_EXERCISE, log = () => {} }) {
  const words = EXERCISE_WORDS[exercise];
  let latest = null; // { counts, visible, at }
  let counterSeen = false;
  let started = false;
  let finished = false;
  let baseline = 0;
  let lastCalled = 0;
  let lastCalloutAt = 0;
  let notVisibleSince = null;
  let lastNudgeAt = 0;
  let timer;
  let lastReported = '';

  const quiet = () => session.agentState !== 'speaking' && session.agentState !== 'thinking' && session.userState !== 'speaking';
  const say = instructions => { try { session.generateReply({ instructions }); } catch (err) { log('reps: reply failed', { error: err?.message }); } };
  const progress = () => Math.max(0, (latest?.counts?.[exercise] ?? baseline) - baseline);

  function send() {
    const reps = { exercise, target: target, progress: progress(), completed: finished, counter_seen: counterSeen, started };
    const key = JSON.stringify(reps);
    if (key === lastReported) return;
    lastReported = key;
    Promise.resolve(report(reps)).catch(err => log('reps: report failed', { error: err?.message }));
  }

  function onData(payload, _participant, _kind, topic) {
    if (topic !== TOPIC) return;
    let msg;
    try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
    if (!counterSeen) { counterSeen = true; log('reps: pose counter connected', { state: msg.state ?? msg.type }); }
    if (msg.type === 'status') { if (msg.state === 'no_camera') log('reps: pose counter sees no camera (audio-only call?)'); return; }
    if (msg.type !== 'reps') return;
    latest = { counts: msg.counts, visible: msg.visible, at: Date.now() };
    if (started) tick();
  }
  room.on(RoomEvent.DataReceived, onData);

  function tick() {
    if (!started || finished) return;
    const now = Date.now();
    const n = progress();

    if (!counterSeen && now - started > NO_COUNTER_MS && now - lastNudgeAt > NUDGE_EVERY_MS) {
      lastNudgeAt = now;
      log('reps: no pose counter in the room (is npm run pose running?)');
    }
    // Body out of frame: coach them back into view.
    if (latest && !latest.visible) notVisibleSince ??= now; else notVisibleSince = null;
    if (notVisibleSince && now - notVisibleSince > NOT_VISIBLE_NUDGE_MS && now - lastNudgeAt > NUDGE_EVERY_MS && quiet()) {
      lastNudgeAt = now;
      say(exercise === 'squat'
        ? 'In one short sentence, ask the caller to prop the phone up and step back until you can see them at least from head to hips (head to feet is best), so you can count their squats.'
        : 'In one short sentence, ask the caller to prop the phone up and step back until their whole body, head to feet, is in the frame, so you can count their reps.');
    }

    if (n >= target) {
      if (!quiet()) return; // celebrate on the next message, once nobody is talking
      finished = true;
      send();
      log('reps: target reached', { exercise, progress: n });
      say(`Celebrate: the caller just finished all ${target} ${words}. Then wrap up the call warmly in one sentence. Use exactly these numbers.`);
      return;
    }
    send();
    // "7... 8...": call out the newest rep when nobody is talking. If we're mid-sentence, the next rep carries the newer number.
    if (n > lastCalled && now - lastCalloutAt >= CALLOUT_MIN_GAP_MS && quiet()) {
      // Catch up out loud if reps happened while the coach was talking ("2, 3, 4!"), so no number goes unsaid.
      // Capped at the last 4 numbers so a big jump stays short.
      const from = Math.max(lastCalled + 1, n - 3);
      const nums = Array.from({ length: n - from + 1 }, (_, i) => from + i).join(', ');
      lastCalled = n;
      lastCalloutAt = now;
      log('reps: callout', { n, said: nums }); // every number the coach is told to say comes from the pose counter
      const left = target - n;
      say(left <= 2 && left > 0
        ? `REP COUNT from the counter: ${n}. Say only "${nums}!" and then "${left} more!" quickly. Nothing else.`
        : `REP COUNT from the counter: ${n}. Say only "${nums}!" quickly and energetically. Nothing else.`);
    }
  }

  return {
    exercise,
    target,
    start() {
      if (started || target <= 0) return;
      // Never send Gemini a new request while it is still talking (greeting, walk celebration): wait for a quiet
      // moment, up to 10 s. A request on top of an active response is the likely trigger of the Gemini Live
      // "CONTENT_TYPE_AUDIO is not supported" crash that ended a call.
      const waitStart = Date.now();
      const begin = () => {
        if (started) return;
        if (!quiet() && Date.now() - waitStart < 10_000) { setTimeout(begin, 300); return; }
        this._begin();
      };
      begin();
    },
    _begin() {
      started = Date.now();
      baseline = latest?.counts?.[exercise] ?? 0; // reps done before the challenge don't count
      log('reps: challenge started', { exercise, target: target, baseline, counter_seen: counterSeen });
      send(); // tells the server the rep phase began (so a hang-up now is "failed", not a free pass)
      say(`In ONE short sentence: "${target} ${words}: prop the phone up so I can see you${exercise === 'squat' ? ' from the head down' : ' head to toe'}, and go!" Do NOT count reps yourself and do not say any rep numbers now.`);
      timer = setInterval(tick, 1000);
    },
    stop() {
      clearInterval(timer);
      room.off(RoomEvent.DataReceived, onData);
    },
  };
}
