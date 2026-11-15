"""Synthetic-pose tests for reps.py:  pose/.venv/bin/python -I pose/test_reps.py"""
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reps import Point, RepCounter, NOSE, SIDES, L_SHOULDER, R_SHOULDER, L_WRIST, R_WRIST, L_HIP, R_HIP, L_ANKLE, R_ANKLE  # noqa: E402


def blank():
    return [Point(500, 500, False) for _ in range(33)]


def side_squat(knee_deg: float):
    """Side view, standing torso; knee angle set by moving the ankle around the knee."""
    p = blank()
    j = SIDES["left"]
    p[NOSE] = Point(500, 100, True)
    p[j["shoulder"]] = Point(500, 200, True)
    p[j["elbow"]] = Point(520, 300, True)
    p[j["wrist"]] = Point(540, 380, True)
    p[j["hip"]] = Point(500, 450, True)
    p[j["knee"]] = Point(600, 500, True)
    a = math.radians(knee_deg)
    # thigh direction knee->hip, rotate by knee angle to get shin direction
    tx, ty = (500 - 600), (450 - 500)
    n = math.hypot(tx, ty)
    tx, ty = tx / n, ty / n
    sx = tx * math.cos(a) - ty * math.sin(a)
    sy = tx * math.sin(a) + ty * math.cos(a)
    p[j["ankle"]] = Point(600 + sx * 150, 500 + sy * 150, True)
    return p


def side_pushup(elbow_deg: float):
    p = blank()
    j = SIDES["left"]
    p[NOSE] = Point(100, 300, True)
    p[j["shoulder"]] = Point(200, 300, True)
    p[j["hip"]] = Point(500, 310, True)
    p[j["knee"]] = Point(650, 315, True)
    p[j["ankle"]] = Point(800, 320, True)
    p[j["elbow"]] = Point(200, 400, True)  # upper arm straight down
    a = math.radians(elbow_deg)
    # upper arm direction elbow->shoulder is (0,-1); forearm = rotate by elbow angle
    fx, fy = -math.sin(a) * -1, -math.cos(a)
    p[j["wrist"]] = Point(200 + fx * 100, 400 - fy * 100 * -1, True)
    return p


def front_jack(arms_up: bool):
    p = blank()
    p[NOSE] = Point(500, 100, True)
    p[L_SHOULDER], p[R_SHOULDER] = Point(450, 200, True), Point(550, 200, True)
    p[L_HIP], p[R_HIP] = Point(460, 450, True), Point(540, 450, True)
    p[L_ANKLE], p[R_ANKLE] = Point(440, 750, True), Point(560, 750, True)
    y = 50 if arms_up else 400
    p[L_WRIST], p[R_WRIST] = Point(400, y, True), Point(600, y, True)
    return p


def run(frames, fps=15, settle=True):
    """Feed frames; by default start with ~1.3 s of the first pose held still (the counter waits for a steady picture)."""
    c = RepCounter()
    if settle and frames:
        frames = [frames[0]] * 20 + list(frames)
    for i, f in enumerate(frames):
        c.update(f, i / fps)
    return c


def cycle(make, lo, hi, reps, steps=10):
    out = []
    for _ in range(reps):
        out += [make(hi - (hi - lo) * k / steps) for k in range(steps + 1)]
        out += [make(lo + (hi - lo) * k / steps) for k in range(steps + 1)]
    return out


failures = 0


def check(name, got, want):
    global failures
    ok = got == want
    failures += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {name}: got {got}, want {want}")


c = run(cycle(side_squat, 80, 175, 5))
check("5 squats", c.counts()["squat"], 5)
check("squats don't count as push-ups", c.counts()["pushup"], 0)

c = run(cycle(side_squat, 135, 175, 5))
check("barely bending (never below 125 deg) doesn't count", c.counts()["squat"], 0)

c = run(cycle(side_squat, 115, 175, 5))
check("loose: partial squats (115 deg) count", c.counts()["squat"], 5)

frames = cycle(side_squat, 80, 175, 3)
for i in range(0, len(frames), 3):  # every third frame: person out of frame
    frames[i] = [Point(q.x, q.y, False) for q in frames[i]]
check("3 squats with hidden frames", run(frames).counts()["squat"], 3)

c = run(cycle(side_pushup, 70, 170, 4))
check("4 push-ups", c.counts()["pushup"], 4)
check("push-ups don't count as squats", c.counts()["squat"], 0)

jacks = []
for _ in range(6):
    jacks += [front_jack(True)] * 4 + [front_jack(False)] * 4
c = run(jacks)
check("6 jumping jacks", c.counts()["jumping_jack"], 6)

c = run([None] * 30)
check("no person: visible", c.visible, False)


# ---- hip-drop fallback: legs out of frame, waist up visible ----
TORSO = 250  # shoulder (y=200) to hip (y=450)


def upper_body(drop: float, nose_dy: float = 0.0, hips_visible: bool = True):
    """Front view from the waist up; hips `drop` torso-lengths below standing. Knees/ankles hidden."""
    p = blank()
    dy = drop * TORSO
    p[NOSE] = Point(500, 100 + dy + nose_dy, True)
    p[L_SHOULDER], p[R_SHOULDER] = Point(450, 200 + dy, True), Point(550, 200 + dy, True)
    p[L_HIP], p[R_HIP] = Point(460, 450 + dy, hips_visible), Point(540, 450 + dy, hips_visible)
    return p


def dips(make, depth, reps, steps=8, stand=6):
    out = [make(0.0) for _ in range(stand)]  # stand still first so it learns the standing position
    for _ in range(reps):
        out += [make(depth * k / steps) for k in range(steps + 1)]
        out += [make(depth * (1 - k / steps)) for k in range(steps + 1)]
        out += [make(0.0) for _ in range(3)]
    return out


c = run(dips(upper_body, 0.8, 5))
check("hip mode: 5 waist-up squats", c.counts()["squat"], 5)
check("hip mode: visible without legs", c.visible, True)
check("waist-up: hip signal in use", "hip" in (c.squat_mode or ""), True)
check("waist-up: head signal in use", "head" in (c.squat_mode or ""), True)

c = run(dips(upper_body, 0.15, 5))
check("hip mode: small sways (0.15 torso) don't count", c.counts()["squat"], 0)

c = run(dips(upper_body, 0.3, 5))
check("loose: shallow waist-up squats (0.3 torso) count", c.counts()["squat"], 5)

nods = [upper_body(0.0, nose_dy=40 * math.sin(i / 2)) for i in range(120)]
check("hip mode: nodding doesn't count", run(nods).counts()["squat"], 0)

c = run(dips(lambda d: upper_body(d, hips_visible=d < 0.5), 0.8, 4))
check("hip mode: hips dip out of frame at the bottom", c.counts()["squat"], 4)

# Mixed: alternate full-body (knee mode) and waist-up (hip mode) reps; one shared count, no doubles.
mixed = dips(upper_body, 0.8, 1) + cycle(side_squat, 80, 175, 1) + dips(upper_body, 0.8, 1) + cycle(side_squat, 80, 175, 1)
check("mixed knee/hip reps: 4 squats, no double count", run(mixed).counts()["squat"], 4)



# ---- facing the camera, whole body visible: knees bend toward the lens, 2D knee angle stays large ----
from reps import L_KNEE, R_KNEE, L_ELBOW, R_ELBOW  # noqa: E402


def front_squat(drop: float, scale: float = 1.0):
    """Front view, head to feet. Hips/shoulders drop; knees push slightly out; ankles fixed. Knee angle ~150-175."""
    p = blank()
    dy = drop * TORSO
    cx = 500
    S = lambda x, y, ok=True: Point(cx + (x - cx) * scale, 400 + (y - 400) * scale, ok)  # zoom about the frame centre
    p[NOSE] = S(500, 100 + dy)
    p[L_SHOULDER], p[R_SHOULDER] = S(450, 200 + dy), S(550, 200 + dy)
    p[L_ELBOW], p[R_ELBOW] = S(430, 320 + dy), S(570, 320 + dy)
    p[L_WRIST], p[R_WRIST] = S(470, 380 + dy), S(530, 380 + dy)
    p[L_HIP], p[R_HIP] = S(460, 450 + dy), S(540, 450 + dy)
    p[L_KNEE], p[R_KNEE] = S(450 - 25 * drop, 600 + dy * 0.4), S(550 + 25 * drop, 600 + dy * 0.4)
    p[L_ANKLE], p[R_ANKLE] = S(450, 750), S(550, 750)
    return p


c = run(dips(front_squat, 0.8, 6))
check("facing camera, legs visible: 6 squats", c.counts()["squat"], 6)
check("facing camera: mode uses hips", "hip" in (c.squat_mode or ""), True)

c = run(dips(front_squat, 0.45, 5))
check("facing camera: shallow-ish squats (0.45 torso) count", c.counts()["squat"], 5)

c = run(dips(front_squat, 0.15, 5))
check("facing camera: sways (0.15 torso) don't count", c.counts()["squat"], 0)

c = run(dips(front_squat, 0.3, 5))
check("loose: shallow front squats (0.3 torso) count", c.counts()["squat"], 5)

closer = [front_squat(0.0) for _ in range(10)] + [front_squat(0.0, scale=1.6) for _ in range(20)] + [front_squat(0.0) for _ in range(20)]
check("stepping closer and back doesn't count", run(closer).counts()["squat"], 0)

# Noisy frames: every 4th frame the torso looks 1.8x bigger (a joint MediaPipe is unsure of). Must not block counting.
noisy = dips(front_squat, 0.6, 6)
for i in range(2, len(noisy), 4):
    noisy[i] = front_squat(0.0, scale=1.8)
check("noisy torso-size frames don't block counting: 6 squats", run(noisy).counts()["squat"], 6)

# Head only: just nose + shoulders in frame (no hips, no legs). The head line drops ~0.75 shoulder-widths per squat.
def head_only(drop: float, nose_dy: float = 0.0):
    p = blank()
    dy = drop * 100
    p[NOSE] = Point(500, 100 + dy + nose_dy, True)
    p[L_SHOULDER], p[R_SHOULDER] = Point(450, 200 + dy, True), Point(550, 200 + dy, True)
    return p


c = run(dips(head_only, 0.75, 5))
check("head only (nose + shoulders): 5 squats", c.counts()["squat"], 5)
check("head only: mode is head", c.squat_mode, "head")
c = run(dips(head_only, 0.3, 5))
check("head only: small dips (0.3 shoulder-widths) don't count", c.counts()["squat"], 0)
nods = [head_only(0.0, nose_dy=45 * math.sin(i / 2)) for i in range(120)]
check("head only: nodding doesn't count", run(nods).counts()["squat"], 0)

# ---- camera motion (phone being picked up / propped) must never count ----
import random  # noqa: E402
random.seed(7)


def moved(p, dx=0.0, dy=0.0, scale=1.0):
    return [Point(500 + (q.x - 500) * scale + dx, 400 + (q.y - 400) * scale + dy, q.ok) for q in p]


# 3 s of the phone being handled: picture drifts and jumps sideways/up-down and zooms in and out.
handled, x, y, z = [], 0.0, 0.0, 1.0
for i in range(45):
    x += random.uniform(-60, 60); y += random.uniform(-80, 80); z = min(1.6, max(0.6, z * random.uniform(0.85, 1.18)))
    handled.append(moved(front_squat(0.0), x, y, z))
check("phone being handled for 3 s: 0 squats", run(handled).counts()["squat"], 0)

# Handling, then set down and real squats: only the real ones count.
c = run(handled + [front_squat(0.0)] * 30 + dips(front_squat, 0.6, 4))
check("handled, then propped, then 4 real squats: 4", c.counts()["squat"], 4)

# Too fast to be real: up-down cycles of 0.4 s.
fast = []
for _ in range(8):
    fast += [front_squat(0.7)] * 3 + [front_squat(0.0)] * 3
n_fast = run(fast).counts()["squat"]
check("8 bobs in 3.2 s count at most 1 per second (<= 3)", n_fast <= 3, True)

sys.exit(1 if failures else 0)
