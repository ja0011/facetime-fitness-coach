// Place an outbound FaceTime call from code, with this project's Chert line and our own agent, and report
// whether it was answered or missed.
//
// Chert's outbound contract ("Bring Your Own Room", docs.trychert.com/facetime/outbound):
//   1. We create a LiveKit room and dispatch our agent into it (chert dev does this for inbound; outbound is ours).
//   2. We mint a short-lived, room-scoped token for Chert's FaceTime bridge.
//   3. POST /api/v1/calls asks Chert to dial a verified phone from our line and join the bridge to that room.
//   4. We poll the call's events. `bridge_ready` means the person answered and FaceTime media is up: we then set
//      the same room metadata chert dev sets, so greet.mjs greets exactly as it does on inbound calls.
//   5. If the call ends (declined, no answer, failed) before `bridge_ready`, it was missed.
//
// Usage: npm run call            (prints one JSON line with the outcome)
// Library: import { placeCall } from './outbound.mjs'   (the step-count server will use this)
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';

const API = 'https://facetime.trychert.com/api/v1';
const RING_TIMEOUT_MS = 75_000; // give up and end the attempt if nobody answers in this long
const MAX_CALL_MS = 6 * 60_000; // Chert caps calls at 5 minutes; this is only a safety net for our polling
const POLL_MS = 700; // bridge_ready -> greeting must happen within 10 s; this leaves plenty of margin

const TERMINAL = new Set(['ended', 'failed', 'rejected']);
// Any of these means FaceTime actually reached the phone. `dialing` is the normal one; the others imply it.
const RANG = new Set(['dialing', 'connecting', 'active', 'bridge_ready']);

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing from .env.local`);
  return value;
}

/** Calls the Chert FaceTime API with project auth. Never logs the key. */
async function chert(path, { method = 'GET', body, idempotencyKey } = {}) {
  const headers = {
    authorization: `Bearer ${env('CHERT_API_KEY')}`,
    'x-chert-project-id': env('CHERT_PROJECT_ID'),
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 300) }; }
  if (!res.ok) {
    const err = new Error(`Chert ${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 400)}`);
    err.status = res.status; err.body = json;
    err.code = json?.code ?? json?.error?.code; // e.g. "line_busy"
    throw err;
  }
  return { status: res.status, json };
}

/**
 * Chert wraps lists in a few ways: lines are { data: { items: [...] } }, call events are
 * { data: { call_id, events: [...] } }. Accept those, { data: [...] } or a bare array; if none match, fail with the
 * response's key names (never its values).
 */
function items(json, what) {
  const d = json?.data;
  const list = Array.isArray(json) ? json : Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : d?.events;
  if (Array.isArray(list)) return list;
  const keys = json && typeof json === 'object' ? Object.keys(json) : [];
  const dataKeys = json?.data && typeof json.data === 'object' ? Object.keys(json.data) : [];
  throw new Error(`Unexpected ${what} response shape: keys=${JSON.stringify(keys)} data keys=${JSON.stringify(dataKeys)}`);
}

/** Lists the project's lines, so you can pick CHERT_LINE_ID. */
export async function listLines() {
  const { json } = await chert('/lines');
  return items(json, 'lines');
}

/**
 * Places one outbound FaceTime call and resolves when it is over.
 * @param {{ destination?: string, video?: boolean, agentMetadata?: object, onEvent?: (e: object) => void }} [opts]
 * Outcome rule (decides the Solana penalty later):
 *   answered = bridge_ready arrived (they picked up and FaceTime media is up)
 *   missed   = the phone rang (dialing/connecting/active happened) but bridge_ready never came
 *   error    = the phone never rang (Chert/LiveKit/agent failure): not the person's fault, so no penalty
 * Failures before Chert accepts the call (agent not running, HTTP error) throw; treat a throw as "error" too.
 * @returns {Promise<{ outcome: 'answered' | 'missed' | 'error', call_id: string, status: string, terminal_reason: string | null,
 *                     answered_at: string | null, ended_at: string | null }>}
 */
export async function placeCall({ destination = env('MY_PHONE'), video = true, agentMetadata = {}, onEvent = () => {} } = {}) {
  const livekitUrl = env('LIVEKIT_URL');
  const httpUrl = livekitUrl.replace(/^ws/, 'http');
  const apiKey = env('LIVEKIT_API_KEY');
  const apiSecret = env('LIVEKIT_API_SECRET');
  const agentName = env('AGENT_NAME');
  const rooms = new RoomServiceClient(httpUrl, apiKey, apiSecret);
  const dispatch = new AgentDispatchClient(httpUrl, apiKey, apiSecret);

  const attempt = randomUUID();
  const roomName = `coach-out-${attempt}`;
  // Same "chert-bridge-" prefix chert dev uses, so chert-rooms/agent code treats it as the caller.
  const bridgeIdentity = `chert-bridge-out-${attempt.slice(0, 8)}`;

  // 1. Room + agent. The room outlives a short empty period so the agent can join before the bridge does.
  await rooms.createRoom({ name: roomName, emptyTimeout: 120, departureTimeout: 20 });
  // agentMetadata (e.g. this call's challenge) reaches the coach as ctx.job.metadata.
  await dispatch.createDispatch(roomName, agentName, { metadata: JSON.stringify({ chert_direction: 'outbound', ...agentMetadata }) });
  onEvent({ type: 'room_ready', room: roomName });

  try {
    // 2. Bridge token: join/publish/subscribe, this room only, 30-minute lifetime (Chert needs >90 s left, <=2 h issued).
    const at = new AccessToken(apiKey, apiSecret, { identity: bridgeIdentity, ttl: 30 * 60 });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    const bridgeToken = await at.toJwt();

    // Give the agent a moment to join so its audio track exists before Chert checks the room.
    await waitForAgent(rooms, roomName, 15_000);

    // 3. Ask Chert to dial. 201 = allocated (not answered). The idempotency key makes a retry safe.
    // Shared lines take one call at a time, often another team's: when_busy "queue" waits up to 2 min for the
    // line (HTTP 202 + queue id) instead of failing with 409 line_busy.
    const createBody = {
      direction: 'outbound',
      mode: 'customer_managed',
      line_id: env('CHERT_LINE_ID'),
      destination,
      destination_type: destination.includes('@') ? 'email' : 'phone',
      media: { audio: true, video },
      livekit_url: livekitUrl,
      participant_token: bridgeToken,
      remote_participant_identity: agentName,
      when_busy: 'queue',
    };
    const created = await createCall(createBody, `create-${attempt}`, onEvent);
    const callId = created.data.id;
    onEvent({ type: 'call_created', call_id: callId, status: created.data.status });

    // 4/5. Watch events until the call is terminal.
    return await watchCall({ callId, roomName, rooms, onEvent });
  } finally {
    // Our room, our cleanup (Chert cleans up only its bridge).
    await rooms.deleteRoom(roomName).catch(() => {});
  }
}

/**
 * POST /calls, waiting in Chert's busy-line queue if needed. Per the docs: 202 { queued: true } means waiting;
 * poll GET /calls/queue/{id}; when its state is "ready", repeat the SAME create (same body and idempotency key)
 * within the 20-second turn. Returns the 201 body.
 */
async function createCall(body, idempotencyKey, onEvent) {
  const first = await chert('/calls', { method: 'POST', idempotencyKey, body });
  if (first.status === 201 || first.json?.data?.id && !isQueued(first.json)) return first.json;

  const q = first.json?.data ?? first.json;
  const queueId = q?.queue_id ?? q?.queue?.id ?? q?.id;
  if (!queueId) throw new Error(`Chert queued the call but returned no queue id (keys: ${JSON.stringify(Object.keys(q ?? {}))})`);
  onEvent({ type: 'line_busy_queued', queue_id: queueId, position: q?.position ?? null });

  const until = Date.now() + 150_000; // Chert's queue waits up to 2 minutes
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 2000));
    const { json } = await chert(`/calls/queue/${queueId}`);
    // Shape: { data: { queued, queue: { id, state: "waiting" | "ready" | ..., position, expires_at }, message } }
    const entry = json?.data ?? json;
    const state = entry?.queue?.state ?? entry?.state ?? entry?.status;
    if (state === 'ready') {
      onEvent({ type: 'line_free', queue_id: queueId });
      const again = await chert('/calls', { method: 'POST', idempotencyKey, body });
      if (isQueued(again.json)) continue; // lost the turn; keep waiting while the queue entry lasts
      return again.json;
    }
    if (['expired', 'cancelled', 'canceled', 'failed'].includes(state)) throw lineBusy(`Busy-line queue ${state}: the line stayed busy (another team's call)`);
  }
  await chert(`/calls/queue/${queueId}`, { method: 'DELETE' }).catch(() => {});
  throw lineBusy('Line stayed busy for 2.5 minutes (another team on the shared line)');
}
/** An error the caller can retry later: the shared line was busy with someone else's call. */
const lineBusy = message => Object.assign(new Error(message), { code: 'line_busy' });
const isQueued = json => (json?.data?.queued ?? json?.queued) === true;

async function waitForAgent(rooms, roomName, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const people = await rooms.listParticipants(roomName).catch(() => []);
    if (people.some(p => p.kind === 4 /* ParticipantInfo_Kind.AGENT */ || p.identity.startsWith('agent-'))) return;
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Agent "${process.env.AGENT_NAME}" did not join the room in ${timeoutMs / 1000}s. Is npm start running?`);
}

async function watchCall({ callId, roomName, rooms, onEvent }) {
  const started = Date.now();
  const seen = new Set();
  let answeredAt = null;
  let rang = false;
  let endRequested = false;

  for (;;) {
    const { json: ev } = await chert(`/calls/${callId}/events`);
    const events = items(ev, 'call events').slice().sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    for (const e of events) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      // Event records are { id, type, at, sequence, source } (older SDK docs call them event_type/created_at).
      const name = e.type ?? e.event_type;
      const at = e.at ?? e.created_at ?? new Date().toISOString();
      onEvent({ type: 'chert_event', event: name, at });
      if (RANG.has(name)) rang = true;
      if (name === 'bridge_ready' && !answeredAt) {
        answeredAt = at;
        // The greeting signal greet.mjs listens for: the same metadata chert dev writes on inbound calls.
        await rooms.updateRoomMetadata(roomName, JSON.stringify({ chert_call: callId, chert_bridge_ready: true, at: new Date().toISOString() }));
        onEvent({ type: 'answered', call_id: callId });
      }
    }

    const { json: c } = await chert(`/calls/${callId}`);
    const call = c.data;
    if (TERMINAL.has(call.status)) {
      return {
        outcome: answeredAt ? 'answered' : rang ? 'missed' : 'error',
        call_id: callId,
        status: call.status,
        terminal_reason: call.terminal_reason ?? null,
        answered_at: answeredAt,
        ended_at: call.ended_at ?? null,
      };
    }

    const elapsed = Date.now() - started;
    if (!endRequested && ((!answeredAt && elapsed > RING_TIMEOUT_MS) || elapsed > MAX_CALL_MS)) {
      endRequested = true;
      onEvent({ type: 'ending', reason: answeredAt ? 'max_duration' : 'ring_timeout' });
      await chert(`/calls/${callId}/end`, { method: 'POST', idempotencyKey: `end-${callId}`, body: {} }).catch(err => onEvent({ type: 'end_failed', error: err.message }));
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// CLI: `npm run call` places a call to MY_PHONE; `npm run call -- --lines` lists line IDs.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const log = obj => console.log(JSON.stringify(obj));
  try {
    if (process.argv.includes('--lines')) {
      for (const line of await listLines()) {
        log({
          id: line.id, name: line.display_name, identity: line.masked_identity, status: line.status,
          availability: line.availability, operational_status: line.operational_status,
          supports_audio: line.supports_audio, supports_video: line.supports_video,
          busy: Boolean(line.current_call_id) || line.worker_occupied, shared: line.shared_line,
        });
      }
    } else {
      const audioOnly = process.argv.includes('--audio');
      const result = await placeCall({ video: !audioOnly, onEvent: log });
      log({ type: 'result', ...result });
    }
  } catch (err) {
    log({ type: 'error', message: err.message });
    process.exitCode = 1;
  }
}
