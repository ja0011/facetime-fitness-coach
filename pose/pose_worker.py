"""Pose rep counter: joins each call's LiveKit room, watches the caller's camera with MediaPipe Pose Landmarker,
counts squats / push-ups / jumping jacks, and sends the counts to the coach agent as LiveKit data messages.

How it gets into the room: it is a named LiveKit agent (POSE_AGENT_NAME, default "<AGENT_NAME>-pose"). The Node coach
dispatches it into its own room as soon as the caller (Chert's bridge) joins, for inbound and outbound calls alike.

It never publishes audio or video (the Chert Mac ends a call if a second participant publishes audio); it only
subscribes to video and sends small data messages to the coach.

Run:  pose/.venv/bin/python pose/pose_worker.py start      (reads LIVEKIT_* and AGENT_NAME from ../.env.local)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT.parent / ".env.local")

import mediapipe as mp  # noqa: E402
import numpy as np  # noqa: E402
from livekit import rtc  # noqa: E402
from livekit.agents import AutoSubscribe, JobContext, WorkerOptions, cli  # noqa: E402
from mediapipe.tasks.python import BaseOptions, vision  # noqa: E402

from reps import NOSE, L_HIP, R_HIP, RepCounter, to_points  # noqa: E402

DEBUG_VIEW = None
if os.environ.get("POSE_DEBUG_VIEW", "1") != "0":
    from debug_view import DebugView  # noqa: E402
    DEBUG_VIEW = DebugView()

POSE_AGENT_NAME = os.environ.get("POSE_AGENT_NAME") or f"{os.environ.get('AGENT_NAME', 'my-agent')}-pose"
MODEL_PATH = ROOT / "models" / os.environ.get("POSE_MODEL", "pose_landmarker_full.task")
TOPIC = "chert.reps"
# Auto-rotate: the FaceTime bridge doesn't rotate a sideways phone's picture, so the person can arrive lying on their
# side. Off for push-ups, where a horizontal body is the real pose.
AUTO_ROTATE = os.environ.get("POSE_AUTO_ROTATE", "1") != "0" and os.environ.get("REPS_EXERCISE", "squat") != "pushup"
ROTATE_AFTER_FRAMES = 30  # ~2 s of a clearly sideways body -> turn the picture (a squat lean lasts ~1 s)
STATS_EVERY_S = 5.0
HEARTBEAT_S = 2.0  # send counts at least this often so the coach knows the counter is alive

log = logging.getLogger("pose")

# Frame rotation reported by LiveKit -> np.rot90 k (counter-clockwise quarter turns) to make the person upright.
ROTATE_K = {
    rtc.VideoRotation.VIDEO_ROTATION_0: 0,
    rtc.VideoRotation.VIDEO_ROTATION_90: -1,
    rtc.VideoRotation.VIDEO_ROTATION_180: 2,
    rtc.VideoRotation.VIDEO_ROTATION_270: 1,
}


def make_landmarker():
    options = vision.PoseLandmarkerOptions(
        base_options=BaseOptions(model_asset_path=str(MODEL_PATH)),
        running_mode=vision.RunningMode.VIDEO,  # uses tracking between frames: faster and steadier than IMAGE
        num_poses=1,
        min_pose_detection_confidence=0.5,
        min_pose_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return vision.PoseLandmarker.create_from_options(options)


def upright_fix(pts) -> int | None:
    """Quarter turns (np.rot90 k, counter-clockwise) that would put the head above the hips. 0 = already upright,
    None = can't tell (head or hips not visible)."""
    hips = [pts[i] for i in (L_HIP, R_HIP) if pts[i].ok]
    if not pts[NOSE].ok or not hips:
        return None
    hx = sum(p.x for p in hips) / len(hips)
    hy = sum(p.y for p in hips) / len(hips)
    dx, dy = pts[NOSE].x - hx, pts[NOSE].y - hy  # image coords: y grows downward
    if dy > 2 * abs(dx):
        return 2       # head clearly below hips: upside down
    if abs(dx) > 2 * abs(dy):
        return 1 if dx > 0 else -1  # head clearly to the side: counter-clockwise if right, clockwise if left
    return 0           # upright, or leaning (e.g. forward in a squat): leave the picture alone


def is_caller(p: rtc.RemoteParticipant) -> bool:
    return p.identity.startswith("chert-bridge-") or p.kind != rtc.ParticipantKind.PARTICIPANT_KIND_AGENT


async def entrypoint(ctx: JobContext):
    try:
        await run_job(ctx)
    finally:
        if DEBUG_VIEW:
            await DEBUG_VIEW.stop()  # always free the viewer port for the next call, whatever happened


async def run_job(ctx: JobContext):
    await ctx.connect(auto_subscribe=AutoSubscribe.VIDEO_ONLY)
    log.info("joined room %s", ctx.room.name)
    landmarker = make_landmarker()
    pool = ThreadPoolExecutor(max_workers=1)  # MediaPipe is not thread-safe; one inference at a time
    loop = asyncio.get_running_loop()
    counter = RepCounter()
    track_ready: asyncio.Future[rtc.RemoteVideoTrack] = loop.create_future()

    def coach_identities() -> list[str]:
        me = ctx.room.local_participant.identity
        return [p.identity for p in ctx.room.remote_participants.values()
                if p.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT and p.identity != me]

    async def send(payload: dict):
        dest = coach_identities()
        if not dest:
            return
        try:
            await ctx.room.local_participant.publish_data(json.dumps(payload), reliable=True, topic=TOPIC, destination_identities=dest)
        except Exception as err:  # the room may be closing
            log.debug("send failed: %s", err)

    def on_track(track: rtc.Track, _pub: rtc.RemoteTrackPublication, participant: rtc.RemoteParticipant):
        if track.kind == rtc.TrackKind.KIND_VIDEO and is_caller(participant) and not track_ready.done():
            log.info("caller camera: %s from %s", track.sid, participant.identity)
            track_ready.set_result(track)

    ctx.room.on("track_subscribed", on_track)
    for p in ctx.room.remote_participants.values():
        for pub in p.track_publications.values():
            if pub.track and pub.kind == rtc.TrackKind.KIND_VIDEO and is_caller(p):
                on_track(pub.track, pub, p)

    await send({"type": "status", "state": "waiting_for_camera"})
    try:
        track = await asyncio.wait_for(track_ready, timeout=120)
    except asyncio.TimeoutError:
        log.warning("no caller camera within 120 s (audio-only call, or caller capture not enabled on the line)")
        await send({"type": "status", "state": "no_camera"})
        return

    stream = rtc.VideoStream(track, format=rtc.VideoBufferType.RGB24)
    t0 = time.monotonic()
    last_ts_ms = -1
    busy = False
    stats = dict(received=0, processed=0, visible=0, knee=0, hip=0, infer_ms=0.0, w=0, h=0, rot=0)
    stats_at = time.monotonic()
    reasons: dict[str, int] = {}  # why visible frames gave no squat reading
    last_sent = 0.0
    last_counts = counter.counts()
    orient = dict(k=0, wrong=0, want=0)  # extra quarter turns (np.rot90 k) to make the person upright

    def infer(rgb: np.ndarray, ts_ms: int):
        start = time.perf_counter()
        result = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts_ms)
        return result, (time.perf_counter() - start) * 1000

    async def process(frame: rtc.VideoFrame, rotation, ts_ms: int):
        nonlocal busy, last_sent, last_counts
        try:
            rgb = np.frombuffer(frame.data, dtype=np.uint8).reshape(frame.height, frame.width, 3)
            k = (ROTATE_K.get(rotation, 0) + orient["k"]) % 4
            rgb = np.ascontiguousarray(np.rot90(rgb, k) if k else rgb)  # copy: the frame buffer is reused
            h, w = rgb.shape[:2]
            result, ms = await loop.run_in_executor(pool, infer, rgb, ts_ms)
            stats["processed"] += 1
            stats["infer_ms"] += ms
            pts = to_points(result.pose_landmarks[0], w, h) if result.pose_landmarks else None
            if AUTO_ROTATE and pts:
                fix = upright_fix(pts)
                if fix is None or fix == 0:
                    orient["wrong"] = 0
                else:
                    orient["wrong"] = orient["wrong"] + 1 if fix == orient["want"] else 1
                    orient["want"] = fix
                    if orient["wrong"] >= ROTATE_AFTER_FRAMES:
                        orient["k"] = (orient["k"] + fix) % 4
                        orient["wrong"] = 0
                        # The picture changed: forget the standing reference so the next squats measure correctly.
                        counter.ref_hip_y = counter.ref_torso = counter.ref_offset = None
                        counter.machines["squat"].state = "up"
                        log.info("person looked sideways/upside-down: rotating the picture %d quarter turn(s) (total %d)", fix, orient["k"])
                        return  # this frame was analyzed in the old orientation
            reps_done = counter.update(pts, ts_ms / 1000)
            if DEBUG_VIEW:
                had = DEBUG_VIEW.runner is not None
                await DEBUG_VIEW.ensure_started()
                if DEBUG_VIEW.runner is not None and not had:
                    log.info("debug view: http://localhost:%d", int(os.environ.get("POSE_DEBUG_PORT", 8090)))
                DEBUG_VIEW.update(rgb, pts, counter, dict(rotate_k=orient["k"], w=w, h=h, ms=ms))
            stats["visible"] += counter.visible
            if counter.squat_mode:
                for part in counter.squat_mode.split("+"):
                    stats[part] = stats.get(part, 0) + 1
            elif counter.visible and counter.no_signal:
                reasons[counter.no_signal] = reasons.get(counter.no_signal, 0) + 1
            counts = counter.counts()
            now = time.monotonic()
            if reps_done or counts != last_counts or now - last_sent >= HEARTBEAT_S:
                last_counts, last_sent = counts, now
                await send({"type": "reps", "counts": counts, "visible": counter.visible, "squat_mode": counter.squat_mode, "t": round(now - t0, 2)})
                for ex in reps_done:
                    log.info("rep: %s -> %d (%s)", ex, counts[ex], counter.squat_mode if ex == "squat" else "angle")
        except Exception as err:
            log.warning("frame failed: %s", err)
        finally:
            busy = False

    async for event in stream:
        frame = event.frame
        stats["received"] += 1
        stats["w"], stats["h"], stats["rot"] = frame.width, frame.height, event.rotation
        now = time.monotonic()
        # Part 2: log what the FaceTime bridge actually delivers, and how much of it we can analyze.
        if now - stats_at >= STATS_EVERY_S:
            span = now - stats_at
            n = stats["processed"]
            log.info("camera %dx%d rot=%s | received %.1f fps | processed %.1f fps | body visible %d%% (squat: head %d%%, knee %d%%, hip %d%%) | inference %.0f ms",
                     stats["w"], stats["h"], rtc.VideoRotation.Name(stats["rot"]) if isinstance(stats["rot"], int) else stats["rot"],
                     stats["received"] / span, n / span, (100 * stats["visible"] / n) if n else 0,
                     (100 * stats.get("head", 0) / n) if n else 0, (100 * stats["knee"] / n) if n else 0, (100 * stats["hip"] / n) if n else 0, (stats["infer_ms"] / n) if n else 0)
            if reasons:
                log.info("no squat reading on %d visible frames: %s", sum(reasons.values()), reasons)
                reasons.clear()
            stats.update(received=0, processed=0, visible=0, head=0, knee=0, hip=0, infer_ms=0.0)
            stats_at = now
        # "Every frame it can": skip frames that arrive while the previous one is still being analyzed.
        if busy:
            continue
        ts_ms = max(int((now - t0) * 1000), last_ts_ms + 1)  # VIDEO mode needs strictly increasing timestamps
        last_ts_ms = ts_ms
        busy = True
        asyncio.create_task(process(frame, event.rotation, ts_ms))

    log.info("camera stream ended; final counts %s", counter.counts())
    if DEBUG_VIEW:
        DEBUG_VIEW.clear()
    landmarker.close()


if __name__ == "__main__":
    if not MODEL_PATH.exists():
        raise SystemExit(f"Model missing: {MODEL_PATH}. Run: bash pose/setup.sh")
    # Its own health-check port: the Node coach's worker already listens on 8081 (the LiveKit default).
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name=POSE_AGENT_NAME, port=int(os.environ.get("POSE_HTTP_PORT", 8082))))
