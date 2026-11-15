import { fileURLToPath } from 'node:url';
import { AutoSubscribe, defineAgent, voice } from '@livekit/agents';
import { AgentDispatchClient } from 'livekit-server-sdk';
import { TrackKind } from '@livekit/rtc-node';
import { runAgent, usesOwnLiveKit } from './chert-rooms.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { GeminiVideoModel, streamCallerVideo } from './video.mjs';
import { startWalkChallenge } from './livesteps.mjs';
import { createRepChallenge } from './repchallenge.mjs';
import { describeChallenge, describeInactivity, EXERCISE_WORDS, pickChallenge } from './challenge.mjs';

const POSE_AGENT_NAME = process.env.POSE_AGENT_NAME || `${process.env.AGENT_NAME || 'my-agent'}-pose`;
const SERVER_URL = process.env.LIVE_STEPS_URL || `http://127.0.0.1:${process.env.PORT || 3000}`;

/** Send challenge progress to server.mjs (it decides answered vs failed for calls it placed). */
async function reportProgress(body) {
  if (!process.env.STEPS_TOKEN) return;
  await fetch(`${SERVER_URL}/walk-progress`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.STEPS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(1500),
  });
}

/** Ask LiveKit to send the pose rep counter (pose/pose_worker.py) into this room. Needs our own LiveKit keys. */
async function dispatchPoseCounter(roomName) {
  if (process.env.POSE_ENABLED === '0') return;
  if (!usesOwnLiveKit()) { console.log('[reps] Chert rooms mode: no LiveKit keys to dispatch the pose counter'); return; }
  try {
    const client = new AgentDispatchClient(process.env.LIVEKIT_URL.replace(/^ws/, 'http'), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    await client.createDispatch(roomName, POSE_AGENT_NAME);
    console.log(`[reps] pose counter "${POSE_AGENT_NAME}" dispatched`);
  } catch (err) {
    console.log('[reps] could not dispatch the pose counter:', err.message);
  }
}

/**
 * This call's challenge and context. Calls placed by server.mjs carry them in the dispatch metadata
 * ({ challenge, inactivity }); calls without them (e.g. you calling the line through chert dev) get a random one.
 */
function callPlan(ctx) {
  let meta = {};
  try { meta = JSON.parse(ctx.job?.metadata || '{}'); } catch {}
  const ch = meta.challenge && typeof meta.challenge === 'object' ? meta.challenge : pickChallenge();
  return {
    walk: Math.max(0, Math.floor(Number(ch.walk) || 0)),
    reps: Math.max(0, Math.floor(Number(ch.reps) || 0)),
    exercise: EXERCISE_WORDS[ch.exercise] ? ch.exercise : 'squat',
    inactivity: meta.inactivity ?? null,
  };
}

// The coach's personality and rules, built for this call's challenge. Keep replies short: this is spoken, and calls
// cap at 5 minutes.
function buildInstructions(plan) {
  const words = EXERCISE_WORDS[plan.exercise];
  const why = describeInactivity(plan.inactivity);
  return `You are Coach, an upbeat AI fitness accountability coach on a FaceTime video call.
The caller works at a desk and has been sitting too long${why ? ` (${why})` : ''}, so you are getting them moving with a
quick challenge right now: ${describeChallenge(plan)}.
You can see the caller through their camera, about one frame per second.

${plan.walk > 0 ? `First, a walk: ${plan.walk} steps, counted live by the StepStream app on their iPhone.
- Right after greeting, explain it in one sentence: open StepStream, tap Start, come back to FaceTime and walk
  ${plan.walk} steps (around the room or hallway is fine).
- You will be told the live step count from time to time. Those numbers are the only source of truth:
  never guess, estimate or invent a step count, and never say a number you were not given.
- Between callouts, keep them moving with short, energetic encouragement.
` : ''}${plan.reps > 0 ? `- ${plan.walk > 0 ? 'After the walk comes' : 'Right after greeting, start'} a rep challenge: ${plan.reps} ${words}. A pose counter watches the camera and you
  will be told each rep number in a message that starts with "REP COUNT from the counter". NEVER count reps yourself
  and never say a rep number unless you were just given it that way, even if you see them moving on video. Between
  counts, only encourage and give form cues of a few words${plan.exercise === 'squat' ? ' (chest up, sit back, knees out)' : ''}.
  If they ask how many they've done, say the last number you were given, or that the counter hasn't counted one yet.
- If you are told the caller's body is out of frame, ask them to step back${plan.exercise === 'squat' ? ' until you can see at least head to hips' : ' so their whole body is visible'}.
` : '- Do not claim an exact rep count from the video.\n'}
Always:
- Speak in one or two short sentences at a time. Never lecture.
- Only describe what you can actually see. If the camera is shaky or dark while they walk, that is fine; do not comment on it.
- The call ends after 5 minutes, so keep things moving and wrap up with a quick recap.
- If they say they feel pain or dizziness, tell them to stop and rest. You are not a doctor.
- Be clear that you are an AI if asked.`;
}

// Said once, as soon as FaceTime is ready (must be within 10 s of bridge_ready). It is the first thing the caller hears.
function buildGreeting(plan) {
  const why = describeInactivity(plan.inactivity);
  return `In one or two short sentences: say you are their AI desk-break coach${why ? `, that ${why}` : ', that it is time to move'}, `
    + `and announce today's challenge exactly as "Today: ${describeChallenge(plan)}." Use exactly these numbers.`;
}

const agent = defineAgent({
  entry: async ctx => {
    // SUBSCRIBE_ALL (not AUDIO_ONLY) so we also receive the caller's FaceTime camera.
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    // Chert prepares a room before a caller exists. Join promptly so Chert can
    // find us, but wait before opening a paid model session. Doctor jobs may end
    // without a caller ever joining.
    const caller = await ctx.waitForParticipant();
    const plan = callPlan(ctx);
    console.log('[plan]', JSON.stringify({ walk: plan.walk, reps: plan.reps, exercise: plan.exercise, inactivity: plan.inactivity }));
    // The caller (Chert's bridge) is here: bring in the pose counter now so it is warm when the rep challenge starts.
    if (plan.reps > 0) void dispatchPoseCounter(ctx.room.name);
    // Gemini Live (reads GOOGLE_API_KEY from .env.local). GeminiVideoModel is the stock model plus a handle
    // on its live session, so video.mjs can push camera frames into it.
    const model = new GeminiVideoModel({ model: 'gemini-2.5-flash-native-audio-preview-12-2025', voice: 'Puck' });

    // ---- Auto-recovery: the Gemini Live session can die mid-call (e.g. "CONTENT_TYPE_AUDIO is not supported").
    // Everything else talks to `coach`, a stable handle; when a session closes with an error while the caller is
    // still on the line, a new session is started behind it and picks up where the challenge stands.
    let session = null;
    let ending = false;
    let recoveries = 0;
    const MAX_RECOVERIES = 3;
    const rlog = (msg, extra = {}) => console.log(`[recover] ${msg}`, JSON.stringify(extra));
    const coach = {
      get agentState() { return session?.agentState ?? 'thinking'; }, // "not quiet" while reconnecting: trackers wait
      get userState() { return session?.userState ?? 'listening'; },
      generateReply(opts) {
        if (!session) throw new Error('coach is reconnecting');
        return session.generateReply(opts);
      },
    };
    const callerHere = () => !ending && ctx.room.remoteParticipants.has(caller.identity);

    async function startSession(note = '') {
      const s = new voice.AgentSession({ llm: model });
      s.on(voice.AgentSessionEventTypes.Close, ev => void onSessionClosed(s, ev));
      await s.start({
        room: ctx.room,
        agent: new voice.Agent({ instructions: buildInstructions(plan) + note }),
        record: false,
        inputOptions: {
          participantIdentity: caller.identity,
          audioEnabled: true,
          videoEnabled: true, // a no-op in Node agents 1.8.0; video.mjs does the real work
          textEnabled: false,
          closeOnDisconnect: true,
          deleteRoomOnClose: false,
        },
        outputOptions: { audioEnabled: true, transcriptionEnabled: false },
      });
      session = s;
      return s;
    }

    async function onSessionClosed(s, ev) {
      if (s !== session) return;
      session = null;
      const reason = ev?.reason;
      // Only an error mid-call is recovered; a hang-up (participant_disconnected) or job shutdown is the real end.
      if (ending || reason !== 'error' || !callerHere()) { rlog('session closed, not recovering', { reason, caller_here: callerHere() }); return; }
      if (recoveries >= MAX_RECOVERIES) { rlog('giving up: too many reconnects this call', { recoveries }); return; }
      recoveries += 1;
      rlog('session died mid-call, reconnecting', { attempt: recoveries, error: ev?.error?.error?.message ?? ev?.error?.message ?? null });
      const started = Date.now();
      for (let tryNo = 1; tryNo <= 3 && callerHere(); tryNo++) {
        await new Promise(r => setTimeout(r, tryNo === 1 ? 600 : 1500));
        if (!callerHere()) return;
        try {
          // The dead session leaves its audio track published. Chert's Mac needs exactly ONE unmuted audio track
          // from the agent, so remove the old one(s) before the new session publishes its own.
          for (const pub of [...ctx.room.localParticipant.trackPublications.values()]) {
            if (pub.kind === TrackKind.KIND_AUDIO && pub.sid) {
              await ctx.room.localParticipant.unpublishTrack(pub.sid).catch(err => rlog('unpublish failed', { error: err.message }));
              rlog('removed stale audio track', { sid: pub.sid });
            }
          }
          const where = progressText();
          await startSession(`\n\nIMPORTANT: your connection dropped for a moment and you are back mid-call. Do not greet again or restart the challenge. Progress right now: ${where}.`);
          session.generateReply({ instructions: `Say "Sorry, I'm back!" and then in one short sentence: ${where}. Tell them to keep going. Use exactly these numbers.` });
          rlog('reconnected', { attempt: recoveries, ms: Date.now() - started, progress: where });
          return;
        } catch (err) {
          rlog('reconnect try failed', { try: tryNo, error: err.message });
        }
      }
    }

    // What to tell the reconnected coach, from the live trackers.
    function progressText() {
      const w = stopWalk.status?.();
      const r = reps.status();
      if (plan.walk > 0 && w && !w.finished) return `the caller has walked ${w.progress} of ${w.target} steps`;
      if (plan.reps > 0 && r.started && !r.finished) return `the caller has done ${r.progress} of ${r.target} ${r.words}`;
      if (plan.reps > 0 && !r.started) return `the walk is done; next is ${r.target} ${r.words}`;
      return `the challenge (${describeChallenge(plan)}) is complete; wrap up warmly`;
    }

    ctx.addShutdownCallback(async () => { ending = true; await session?.close(); });
    await startSession();

    // Testing hook: POST /api/debug/crash on the step server sends this data message to force the exact
    // fatal error Gemini raised in real calls. Accepted only from the server (not from Chert's bridge or the pose worker).
    ctx.room.on('dataReceived', (payload, participant, _kind, topic) => {
      if (topic !== 'coach.debug' || participant) return;
      let msg; try { msg = JSON.parse(new TextDecoder().decode(payload)); } catch { return; }
      if (msg.action === 'crash' && model.liveSession) {
        rlog('forced test crash requested');
        model.liveSession.emitError(new Error('Forced test crash (debug)'), false);
      }
    });

    // Greet once when chert dev reports that FaceTime is ready (bridge_ready in the
    // room metadata): the Mac ends the call if it hears nothing within 10 seconds
    // of that. Participant arrival alone is not readiness, so there is no greeting
    // on it. Without the signal there is no greeting, and the caller speaks first.
    const stopVideo = streamCallerVideo(ctx.room, caller.identity, model);
    ctx.addShutdownCallback(async () => stopVideo());
    // Rep counts start arriving as soon as the pose counter joins; the challenge itself starts after the walk.
    const reps = createRepChallenge({
      room: ctx.room,
      session: coach,
      report: r => reportProgress({ room: ctx.room.name, reps: r }),
      target: plan.reps,
      exercise: plan.exercise,
      log: (msg, extra = {}) => console.log(`[reps] ${msg}`, JSON.stringify(extra)),
    });
    // The walking challenge starts with the call itself (bridge_ready), not with the waiting room.
    let stopWalk = () => {};
    const stopGreeting = greetOnBridgeReady(ctx.room, () => {
      coach.generateReply({ instructions: buildGreeting(plan) });
      if (plan.walk <= 0) {
        // No walk in this challenge: go straight to the reps. start() also waits until the coach is quiet.
        const t = setTimeout(() => reps.start(), 4000);
        stopWalk = () => clearTimeout(t);
        return;
      }
      stopWalk = startWalkChallenge({
        session: coach,
        callStart: Date.now(),
        room: ctx.room.name,
        target: plan.walk,
        onComplete: plan.reps > 0 ? () => reps.start() : undefined,
        log: (msg, extra = {}) => console.log(`[walk] ${msg}`, JSON.stringify(extra)),
      });
    });
    ctx.addShutdownCallback(async () => { stopGreeting(); stopWalk(); reps.stop(); });
  },
});

export default agent;

// Your own LiveKit project when .env.local has its three LIVEKIT_ values; otherwise Chert rooms through chert dev.
runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'student-agent' });
