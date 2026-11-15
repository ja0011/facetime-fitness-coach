"""Live debug viewer: what the pose counter sees, at http://localhost:8090 (this Mac only).

Shows the analysed frame (after auto-rotation) with the detected skeleton and the counter's state. One frame is kept
in memory and nothing is written to disk. Turn it off with POSE_DEBUG_VIEW=0 in .env.local.
"""
from __future__ import annotations

import os
import time

import cv2
import numpy as np
from aiohttp import web

from reps import HEAD_DOWN, HEAD_UP, HIP_DOWN, HIP_UP, Point

PORT = int(os.environ.get("POSE_DEBUG_PORT", 8090))
MAX_FPS = 5

# Skeleton edges between MediaPipe landmark indices (head, arms, torso, legs).
EDGES = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24),
         (23, 25), (25, 27), (24, 26), (26, 28), (0, 11), (0, 12)]

PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pose counter view</title><style>
body{margin:0;background:#111;color:#eee;font:14px -apple-system,system-ui,sans-serif;display:flex;flex-direction:column;align-items:center}
img{max-width:100vw;max-height:92vh;margin-top:8px;background:#000}#s{padding:6px;color:#aaa}
</style></head><body><div id="s">Waiting for a call&hellip;</div><img id="v" alt="pose counter view">
<script>
const v=document.getElementById('v'), s=document.getElementById('s');
async function tick(){
  try{ const r=await fetch('/frame.jpg?'+Date.now()); if(r.status===200){ const b=await r.blob(); const u=URL.createObjectURL(b);
       const old=v.src; v.src=u; if(old.startsWith('blob:')) URL.revokeObjectURL(old); s.textContent='Live: what MediaPipe sees';}
       else s.textContent='Waiting for a call… (no frames yet)'; }
  catch(e){ s.textContent='Pose worker not reachable'; }
  setTimeout(tick, 200);
}
tick();
</script></body></html>"""


class DebugView:
    def __init__(self):
        self.jpeg: bytes | None = None
        self.at = 0.0
        self.runner: web.AppRunner | None = None
        self.last_try = 0.0

    async def start(self):
        app = web.Application()
        app.router.add_get("/", lambda _r: web.Response(text=PAGE, content_type="text/html"))
        app.router.add_get("/frame.jpg", self._frame)
        runner = web.AppRunner(app)
        await runner.setup()
        try:
            await web.TCPSite(runner, "127.0.0.1", PORT).start()  # localhost only: frames never leave this Mac
        except OSError:
            await runner.cleanup()
            raise
        self.runner = runner

    async def ensure_started(self) -> None:
        """Try to open the port (at most every 2 s) until it works: a previous call's process may still hold it."""
        if self.runner is not None or time.monotonic() - self.last_try < 2:
            return
        self.last_try = time.monotonic()
        try:
            await self.start()
        except OSError:
            self.runner = None

    async def _frame(self, _req):
        if self.jpeg is None or time.monotonic() - self.at > 5:
            return web.Response(status=204)
        return web.Response(body=self.jpeg, content_type="image/jpeg", headers={"Cache-Control": "no-store"})

    def clear(self):
        self.jpeg = None

    async def stop(self):
        """Free the port at the end of a call: each call runs in its own process, and the next one needs it."""
        self.jpeg = None
        if self.runner:
            await self.runner.cleanup()
        self.runner = None

    def update(self, rgb: np.ndarray, pts: list[Point] | None, counter, info: dict):
        """Draw the skeleton + counter state on a copy of the analysed frame (rate-limited)."""
        now = time.monotonic()
        if now - self.at < 1 / MAX_FPS:
            return
        img = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        h, w = img.shape[:2]
        scale = max(1.0, w / 960)
        if pts:
            for a, b in EDGES:
                if pts[a].ok and pts[b].ok:
                    cv2.line(img, (int(pts[a].x), int(pts[a].y)), (int(pts[b].x), int(pts[b].y)), (255, 255, 255), int(2 * scale))
            for i in [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]:
                p = pts[i]
                cv2.circle(img, (int(p.x), int(p.y)), int(6 * scale), (80, 220, 80) if p.ok else (60, 60, 230), -1)
        sq = counter.machines["squat"]
        drop, knee = counter.last_drop, counter.last_knee
        lines = [
            f"squats {sq.count}   state {sq.state.upper()}   mode {counter.squat_mode or '-'}",
            f"head drop {counter.last_head:.2f} (down > {HEAD_DOWN}, up < {HEAD_UP})" if counter.last_head is not None else "head drop -",
            f"hip drop {drop:.2f} (down > {HIP_DOWN}, up < {HIP_UP})" if drop is not None else "hip drop -",
            f"knee {knee:.0f} deg (down < 125, up > 140)" if knee is not None else "knee -",
            f"visible {'yes' if counter.visible else 'NO'}   no reading: {counter.no_signal or '-'}",
            f"rotation +{info.get('rotate_k', 0)} | {info.get('w')}x{info.get('h')} | inference {info.get('ms', 0):.0f} ms",
        ]
        pad = int(10 * scale)
        box_h = int((len(lines) * 26 + 14) * scale)
        overlay = img.copy()
        cv2.rectangle(overlay, (0, 0), (int(min(w, 620 * scale)), box_h), (0, 0, 0), -1)
        img = cv2.addWeighted(overlay, 0.55, img, 0.45, 0)
        for n, text in enumerate(lines):
            color = (80, 220, 255) if n == 0 else (235, 235, 235)
            cv2.putText(img, text, (pad, int((26 * (n + 1)) * scale)), cv2.FONT_HERSHEY_SIMPLEX, 0.6 * scale, color, max(1, int(scale)), cv2.LINE_AA)
        # Depth bar: hip drop against the down/up lines.
        if drop is not None:
            bx, by, bh = w - int(40 * scale), int(20 * scale), int(h * 0.5)
            cv2.rectangle(img, (bx, by), (bx + int(20 * scale), by + bh), (90, 90, 90), 1)
            fill = int(max(0.0, min(1.0, drop / 0.8)) * bh)
            cv2.rectangle(img, (bx, by), (bx + int(20 * scale), by + fill), (80, 220, 80) if drop > HIP_DOWN else (200, 200, 200), -1)
            for thr, col in ((HIP_DOWN, (80, 220, 255)), (HIP_UP, (255, 180, 80))):
                y = by + int(thr / 0.8 * bh)
                cv2.line(img, (bx - int(6 * scale), y), (bx + int(26 * scale), y), col, max(1, int(scale)))
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 70])
        if ok:
            self.jpeg, self.at = buf.tobytes(), now
