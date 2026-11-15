import { fileURLToPath } from 'node:url';
import { AutoSubscribe, defineAgent, voice } from '@livekit/agents';
import { AgentDispatchClient } from 'livekit-server-sdk';
import { runAgent, usesOwnLiveKit } from './chert-rooms.mjs';
import { greetOnBridgeReady } from './greet.mjs';
import { GeminiVideoModel, streamCallerVideo } from './video.mjs';
import { startWalkChallenge, WALK_TARGET } from './livesteps.mjs';
import { createRepChallenge, EXERCISE_WORDS, REPS_EXERCISE, REPS_TARGET } from './repchallenge.mjs';

const REP_WORDS = EXERCISE_WORDS[REPS_EXERCISE];
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
  if (REPS_TARGET <= 0 || process.env.POSE_ENABLED === '0') return;
  if (!usesOwnLiveKit()) { console.log('[reps] Chert rooms mode: no LiveKit keys to dispatch the pose counter'); return; }
  try {
    const client = new AgentDispatchClient(process.env.LIVEKIT_URL.replace(/^ws/, 'http'), process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    await client.createDispatch(roomName, POSE_AGENT_NAME);
    console.log(`[reps] pose counter "${POSE_AGENT_NAME}" dispatched`);
  } catch (err) {
    console.log('[reps] could not dispatch the pose counter:', err.message);
  }
}

// The coach's personality and rules. Keep replies short: this is spoken, and calls cap at 5 minutes.
// WALK_TARGET (default 300) is sized for the 5-minute cap: a brisk walk is ~100-120 steps a minute.
const instructions = `You are Coach, an upbeat AI fitness accountability coach on a FaceTime video call.
The caller missed their daily step goal, so you are getting them through a short workout right now.
You can see the caller through their camera, about one frame per second.

${WALK_TARGET > 0 ? `The main event is a walking challenge: ${WALK_TARGET} steps, counted live by the StepStream app on their iPhone.
- Right after greeting, explain the challenge in one sentence: open StepStream, tap Start, come back to FaceTime and
  walk ${WALK_TARGET} steps (around the room or hallway is fine). It takes about three minutes at a brisk pace.
- You will be told the live step count from time to time. Those numbers are the only source of truth:
  never guess, estimate or invent a step count, and never say a number you were not given.
- Between callouts, keep them moving with short, energetic encouragement and pacing tips (swing your arms, pick up the pace).
` : `The workout today is a rep challenge only (no walk).
`}
${REPS_TARGET > 0 ? `- ${WALK_TARGET > 0 ? 'After the walk comes' : 'Right after greeting, start'} a rep challenge: ${REPS_TARGET} ${REP_WORDS}. A pose counter watches the camera and you will be
  told each rep number in a message that starts with "REP COUNT from the counter". NEVER count reps yourself and
  never say a rep number unless you were just given it that way, even if you see them moving on video. Between
  counts, only encourage and give form cues of a few words (for squats: chest up, sit back, knees out).
  If they ask how many they've done, say the last number you were given, or that the counter hasn't counted one yet.
- If you are told the caller's body is out of frame, ask them to step back${REPS_EXERCISE === 'squat' ? ' until you can see at least head to hips' : ' so their whole body is visible'}.` : `- Do not claim an exact rep count from the video.`}

Always:
- Speak in one or two short sentences at a time. Never lecture.
- Only describe what you can actually see. If the camera is shaky or dark while they walk, that is fine; do not comment on it.
- The call ends after 5 minutes, so keep things moving and wrap up with a quick recap.
- If they say they feel pain or dizziness, tell them to stop and rest. You are not a doctor.
- Be clear that you are an AI if asked.`;
// Said once, as soon as FaceTime is ready (must be within 10 s of bridge_ready). It is the first thing the caller hears.
const plan = [WALK_TARGET > 0 && `a ${WALK_TARGET}-step walk`, REPS_TARGET > 0 && `${REPS_TARGET} ${REP_WORDS}`].filter(Boolean).join(' and ') || 'a quick workout';
const greeting = `In one short sentence, say you are their AI workout coach, that they missed their step goal, and that you are doing ${plan} together right now.`;

const agent = defineAgent({
  entry: async ctx => {
    // SUBSCRIBE_ALL (not AUDIO_ONLY) so we also receive the caller's FaceTime camera.
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    // Chert prepares a room before a caller exists. Join promptly so Chert can
    // find us, but wait before opening a paid model session. Doctor jobs may end
    // without a caller ever joining.
    const caller = await ctx.waitForParticipant();
    // The caller (Chert's bridge) is here: bring in the pose counter now so it is warm when the rep challenge starts.
    void dispatchPoseCounter(ctx.room.name);
    // Gemini Live (reads GOOGLE_API_KEY from .env.local). GeminiVideoModel is the stock model plus a handle
    // on its live session, so video.mjs can push camera frames into it.
    const model = new GeminiVideoModel({ model: 'gemini-2.5-flash-native-audio-preview-12-2025', voice: 'Puck' });
    const session = new voice.AgentSession({ llm: model });
    ctx.addShutdownCallback(() => session.close());
    await session.start({
      room: ctx.room,
      agent: new voice.Agent({ instructions }),
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
    // Greet once when chert dev reports that FaceTime is ready (bridge_ready in the
    // room metadata): the Mac ends the call if it hears nothing within 10 seconds
    // of that. Participant arrival alone is not readiness, so there is no greeting
    // on it. Without the signal there is no greeting, and the caller speaks first.
    const stopVideo = streamCallerVideo(ctx.room, caller.identity, model);
    ctx.addShutdownCallback(async () => stopVideo());
    // Rep counts start arriving as soon as the pose counter joins; the challenge itself starts after the walk.
    const reps = createRepChallenge({
      room: ctx.room,
      session,
      report: r => reportProgress({ room: ctx.room.name, reps: r }),
      log: (msg, extra = {}) => console.log(`[reps] ${msg}`, JSON.stringify(extra)),
    });
    // The walking challenge starts with the call itself (bridge_ready), not with the waiting room.
    let stopWalk = () => {};
    const stopGreeting = greetOnBridgeReady(ctx.room, () => {
      session.generateReply({ instructions: greeting });
      if (WALK_TARGET <= 0) {
        // Walk skipped (WALK_TARGET=0): go straight to the rep challenge. start() also waits until the coach is quiet.
        const t = setTimeout(() => reps.start(), 4000);
        stopWalk = () => clearTimeout(t);
        return;
      }
      stopWalk = startWalkChallenge({
        session,
        callStart: Date.now(),
        room: ctx.room.name,
        onComplete: REPS_TARGET > 0 ? () => reps.start() : undefined,
        log: (msg, extra = {}) => console.log(`[walk] ${msg}`, JSON.stringify(extra)),
      });
    });
    ctx.addShutdownCallback(async () => { stopGreeting(); stopWalk(); reps.stop(); });
  },
});

export default agent;

// Your own LiveKit project when .env.local has its three LIVEKIT_ values; otherwise Chert rooms through chert dev.
runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'student-agent' });
