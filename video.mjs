// Send the caller's FaceTime camera to Gemini Live.
//
// Why this file exists: in @livekit/agents 1.8.0 (Node), `inputOptions.videoEnabled` is accepted but nothing
// reads the caller's video, and the Google plugin's RealtimeSession.pushVideo() is an empty function. So we
// do it ourselves: subscribe to the caller's camera track, sample about one frame per second (the rate Gemini
// Live is built for), encode it as a small JPEG and send it as realtime input on the live session.
import { RoomEvent, TrackKind, VideoBufferType, VideoStream } from '@livekit/rtc-node';
import * as google from '@livekit/agents-plugin-google';
import sharp from 'sharp';

const FRAME_INTERVAL_MS = 1000; // ~1 fps: enough to see form, cheap on tokens over a 5-minute call
const MAX_SIDE = 768; // Gemini downsamples anyway; smaller frames upload faster
const JPEG_QUALITY = 70;

/** Gemini RealtimeModel that remembers the live session it opens, so we can push video into it. */
export class GeminiVideoModel extends google.realtime.RealtimeModel {
  /** @type {any} */
  liveSession = undefined;
  session() {
    this.liveSession = super.session();
    return this.liveSession;
  }
}

/**
 * Stream the caller's camera to the model. Returns a function that stops it.
 * @param {import('@livekit/rtc-node').Room} room
 * @param {string} callerIdentity
 * @param {GeminiVideoModel} model
 */
export function streamCallerVideo(room, callerIdentity, model) {
  let stopped = false;
  /** @type {ReadableStreamDefaultReader | undefined} */
  let reader;
  let currentTrackSid;
  let loggedFirstFrame = false;

  async function pump(track) {
    if (stopped || currentTrackSid === track.sid) return;
    currentTrackSid = track.sid;
    reader?.cancel().catch(() => {});
    const myReader = (reader = new VideoStream(track).getReader());
    console.log(`[video] receiving caller camera (${track.sid})`);
    let lastSent = 0;
    let encoding = false;
    try {
      while (!stopped) {
        const { value, done } = await myReader.read();
        if (done) break;
        const now = Date.now();
        // Skip frames while one is still encoding or until a second has passed.
        if (encoding || now - lastSent < FRAME_INTERVAL_MS || !model.liveSession) continue;
        lastSent = now;
        encoding = true;
        sendFrame(value.frame)
          .catch(err => console.warn('[video] frame dropped:', err?.message || err))
          .finally(() => { encoding = false; });
      }
    } catch (err) {
      if (!stopped) console.warn('[video] stream ended:', err?.message || err);
    } finally {
      if (currentTrackSid === track.sid) currentTrackSid = undefined;
    }
  }

  async function sendFrame(frame) {
    const rgba = frame.type === VideoBufferType.RGBA ? frame : frame.convert(VideoBufferType.RGBA);
    const jpeg = await sharp(Buffer.from(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength), {
      raw: { width: rgba.width, height: rgba.height, channels: 4 },
    })
      .resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    if (stopped || !model.liveSession) return;
    model.liveSession.sendClientEvent({
      type: 'realtime_input',
      value: { mediaChunks: [{ mimeType: 'image/jpeg', data: jpeg.toString('base64') }] },
    });
    if (!loggedFirstFrame) {
      loggedFirstFrame = true;
      console.log(`[video] first frame sent to Gemini (${rgba.width}x${rgba.height} -> ${jpeg.length} bytes)`);
    }
  }

  const onSubscribed = (track, _publication, participant) => {
    if (participant.identity === callerIdentity && track.kind === TrackKind.KIND_VIDEO) void pump(track);
  };
  room.on(RoomEvent.TrackSubscribed, onSubscribed);
  // The caller's camera may already be subscribed by the time we get here.
  const caller = room.remoteParticipants.get(callerIdentity);
  caller?.trackPublications.forEach(pub => { if (pub.track && pub.kind === TrackKind.KIND_VIDEO) void pump(pub.track); });

  return () => {
    stopped = true;
    room.off(RoomEvent.TrackSubscribed, onSubscribed);
    reader?.cancel().catch(() => {});
  };
}
