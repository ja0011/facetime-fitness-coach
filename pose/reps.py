"""Rep counting from MediaPipe Pose landmarks. Pure logic (no LiveKit, no MediaPipe import) so it can be unit-tested.

Each exercise is a two-state machine with hysteresis: a rep counts only after the joint angle goes past the "down"
threshold AND comes back past the "up" threshold. The gap between the two thresholds stops jitter around one angle
from counting as many reps. Angles are smoothed (EMA) and a rep must take at least MIN_REP_S.

Frames where the body isn't fully visible are ignored: they neither advance nor reset the state machine, so a
person stepping half out of frame mid-squat just resumes when they're back.

Squats have two signals feeding ONE state machine (so switching between them can't double count):
- "knee": hip-knee-ankle angle, when a whole side (head to ankle) is visible. Most accurate.
- "hip":  fallback when the legs are out of frame but shoulders and hips are visible. The hips must drop more than
  HIP_DOWN torso-lengths below where they sit when standing, then come back within HIP_UP. Measuring in torso-lengths
  makes it work near or far from the camera; a nod moves only the head, so it never counts. Needs a still camera.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

# MediaPipe Pose landmark indices
NOSE = 0
L_SHOULDER, R_SHOULDER = 11, 12
L_ELBOW, R_ELBOW = 13, 14
L_WRIST, R_WRIST = 15, 16
L_HIP, R_HIP = 23, 24
L_KNEE, R_KNEE = 25, 26
L_ANKLE, R_ANKLE = 27, 28

SIDES = {
    "left": dict(shoulder=L_SHOULDER, elbow=L_ELBOW, wrist=L_WRIST, hip=L_HIP, knee=L_KNEE, ankle=L_ANKLE),
    "right": dict(shoulder=R_SHOULDER, elbow=R_ELBOW, wrist=R_WRIST, hip=R_HIP, knee=R_KNEE, ankle=R_ANKLE),
}

MIN_VISIBILITY = 0.6
EDGE_MARGIN = 0.02  # a landmark this close to (or past) the frame edge counts as out of frame
MIN_REP_S = 0.5
EMA_ALPHA = 0.5

EXERCISES = ("squat", "pushup", "jumping_jack")

HIP_DOWN = 0.35  # hip drop (torso-lengths) that counts as "down" (a normal squat drops ~0.5-1.0)
HIP_UP = 0.15    # back within this = "up"
REF_ALPHA = 0.2  # how fast the standing reference adapts (only while standing)
RESCALE = (0.75, 1.33)  # torso length outside this ratio of the reference = the person moved: re-learn, don't count


@dataclass
class Point:
    x: float  # pixels
    y: float  # pixels (down is +)
    ok: bool  # visible and inside the frame


def to_points(landmarks, width: int, height: int) -> list[Point]:
    """MediaPipe normalized landmarks -> pixel points. Pixels, not normalized units: a 9:16 frame would otherwise
    squash every angle."""
    pts = []
    for lm in landmarks:
        vis = getattr(lm, "visibility", 1.0) or 0.0
        inside = EDGE_MARGIN <= lm.x <= 1 - EDGE_MARGIN and EDGE_MARGIN <= lm.y <= 1 - EDGE_MARGIN
        pts.append(Point(lm.x * width, lm.y * height, vis >= MIN_VISIBILITY and inside))
    return pts


def angle(a: Point, b: Point, c: Point) -> float:
    """Angle ABC in degrees."""
    v1 = (a.x - b.x, a.y - b.y)
    v2 = (c.x - b.x, c.y - b.y)
    n1, n2 = math.hypot(*v1), math.hypot(*v2)
    if n1 == 0 or n2 == 0:
        return 180.0
    cos = max(-1.0, min(1.0, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
    return math.degrees(math.acos(cos))


def tilt_from_horizontal(a: Point, b: Point) -> float:
    """0 = the a->b line is horizontal, 90 = vertical."""
    return math.degrees(math.atan2(abs(b.y - a.y), abs(b.x - a.x) or 1e-9))


def full_side(pts: list[Point], side: str) -> bool:
    """Head plus one whole side (shoulder, elbow, wrist, hip, knee, ankle) in frame: the body is fully visible
    for a side view. The far side is often hidden behind the body, so one side is enough."""
    return pts[NOSE].ok and all(pts[i].ok for i in SIDES[side].values())


def torso(pts: list[Point]) -> tuple[float, float, float] | None:
    """(hip_y, shoulder_y, torso_length) in pixels from whichever side(s) show both shoulder and hip, else None."""
    sides = [j for j in SIDES.values() if pts[j["shoulder"]].ok and pts[j["hip"]].ok]
    if not sides:
        return None
    hy = sum(pts[j["hip"]].y for j in sides) / len(sides)
    sy = sum(pts[j["shoulder"]].y for j in sides) / len(sides)
    length = sum(math.hypot(pts[j["hip"]].x - pts[j["shoulder"]].x, pts[j["hip"]].y - pts[j["shoulder"]].y) for j in sides) / len(sides)
    return hy, sy, length


def shoulders_y(pts: list[Point]) -> float | None:
    ys = [pts[i].y for i in (L_SHOULDER, R_SHOULDER) if pts[i].ok]
    return sum(ys) / len(ys) if ys else None


def full_front(pts: list[Point]) -> bool:
    """Head plus both shoulders, wrists, hips and ankles: fully visible from the front (jumping jacks)."""
    return all(pts[i].ok for i in (NOSE, L_SHOULDER, R_SHOULDER, L_WRIST, R_WRIST, L_HIP, R_HIP, L_ANKLE, R_ANKLE))


@dataclass
class Machine:
    """down_when(value) / up_when(value) drive the up -> down -> up cycle; a rep counts on the return to up."""
    count: int = 0
    state: str = "up"
    smoothed: float | None = None
    went_down_at: float = 0.0
    last_rep_at: float = -1e9

    def step(self, value: float, t: float, is_down: bool, is_up: bool) -> bool:
        if self.state == "up" and is_down:
            self.state, self.went_down_at = "down", t
        elif self.state == "down" and is_up and t - self.last_rep_at >= MIN_REP_S:
            self.state, self.last_rep_at = "up", t
            self.count += 1
            return True
        return False


@dataclass
class RepCounter:
    machines: dict[str, Machine] = field(default_factory=lambda: {e: Machine() for e in EXERCISES})
    visible: bool = False
    squat_mode: str | None = None  # "hip+knee", "hip", "knee" or None (which signals this frame had)
    ema: dict[str, float] = field(default_factory=dict)
    # Fallback reference, learned while standing: where the hips sit, torso length, and shoulder-to-hip offset.
    ref_hip_y: float | None = None
    ref_torso: float | None = None
    ref_offset: float | None = None

    def _smooth(self, name: str, value: float) -> float:
        """EMA per signal name ("squat" knee angle, "squat_hip" drop, "pushup" elbow): never mixes units."""
        prev = self.ema.get(name)
        self.ema[name] = value if prev is None else EMA_ALPHA * value + (1 - EMA_ALPHA) * prev
        return self.ema[name]

    def update(self, pts: list[Point] | None, t: float) -> list[str]:
        """Feed one frame (pts=None when no person was detected). Returns the exercises that just completed a rep."""
        done: list[str] = []
        if not pts:
            self.visible = False
            return done
        sides = [s for s in SIDES if full_side(pts, s)]
        front = full_front(pts)
        tor = torso(pts)
        # Shoulders alone are enough once the standing reference is known: hips that dip out of the bottom of the
        # frame mid-squat are estimated from the shoulders.
        can_estimate = self.ref_offset is not None and shoulders_y(pts) is not None
        self.visible = bool(sides) or front or tor is not None or can_estimate
        self.squat_mode = None
        if not self.visible:
            return done  # ignore: don't advance or reset any state machine

        def best(fn):
            vals = [fn(SIDES[s]) for s in sides]
            return sum(vals) / len(vals) if vals else None

        # Squat. Two signals, one state machine:
        #  - hip drop (torso-lengths below standing): works from ANY angle, including facing the camera, where the
        #    knees bend toward the lens and the 2D knee angle barely changes;
        #  - knee angle (hip-knee-ankle), when a whole side is visible: a strong extra "down" signal side-on.
        # Down = hips dropped OR knees bent; up = hips back near standing AND (if visible) legs nearly straight.
        squat = self.machines["squat"]
        knee = best(lambda j: angle(pts[j["hip"]], pts[j["knee"]], pts[j["ankle"]]))
        torso_tilt = best(lambda j: tilt_from_horizontal(pts[j["shoulder"]], pts[j["hip"]]))
        knee = self._smooth("squat", knee) if knee is not None and torso_tilt is not None and torso_tilt > 45 else None
        drop = self._hip_drop(pts, tor, standing=squat.state == "up" and (knee is None or knee > 160))
        if knee is not None or drop is not None:
            self.squat_mode = "hip+knee" if (knee is not None and drop is not None) else ("knee" if knee is not None else "hip")
            is_down = (drop is not None and drop > HIP_DOWN) or (knee is not None and knee < 100)
            is_up = (drop is None or drop < HIP_UP) and (knee is None or knee > 150)
            if squat.step(0.0, t, is_down=is_down, is_up=is_up):
                done.append("squat")

        # Push-up: elbow angle (shoulder-elbow-wrist) with a near-horizontal body. Down < 90 deg, up > 155 deg.
        elbow = best(lambda j: angle(pts[j["shoulder"]], pts[j["elbow"]], pts[j["wrist"]]))
        body_tilt = best(lambda j: tilt_from_horizontal(pts[j["shoulder"]], pts[j["ankle"]]))
        if elbow is not None and body_tilt is not None and body_tilt < 35:
            e = self._smooth("pushup", elbow)
            if self.machines["pushup"].step(e, t, is_down=e < 90, is_up=e > 155):
                done.append("pushup")

        # Jumping jack: both wrists above the head ("down" phase of the machine), then both below the shoulders.
        if front:
            above = pts[L_WRIST].y < pts[NOSE].y and pts[R_WRIST].y < pts[NOSE].y
            below = pts[L_WRIST].y > pts[L_SHOULDER].y and pts[R_WRIST].y > pts[R_SHOULDER].y
            if self.machines["jumping_jack"].step(0.0, t, is_down=above, is_up=below):
                done.append("jumping_jack")
        return done

    def _learn_standing(self, hip_y: float, shoulder_y: float, length: float):
        if self.ref_hip_y is None:
            self.ref_hip_y, self.ref_torso, self.ref_offset = hip_y, length, hip_y - shoulder_y
            return
        a = REF_ALPHA
        self.ref_hip_y = a * hip_y + (1 - a) * self.ref_hip_y
        self.ref_torso = a * length + (1 - a) * self.ref_torso
        self.ref_offset = a * (hip_y - shoulder_y) + (1 - a) * self.ref_offset

    def _hip_drop(self, pts: list[Point], tor, standing: bool) -> float | None:
        """Hip drop below the standing reference, in torso-lengths. None if it can't be measured this frame."""
        if tor is not None:
            hip_y, shoulder_y, length = tor
            tilt = best_tilt(pts)
            if tilt is not None and tilt < 35:
                return None  # torso near horizontal: not a squat (push-up position, lying down)
        else:
            # Hips dipped out of the bottom of the frame mid-squat: estimate them from the shoulders.
            sy = shoulders_y(pts)
            if sy is None or self.ref_offset is None:
                return None
            hip_y = sy + self.ref_offset
        if self.ref_hip_y is None or not self.ref_torso:
            if tor is not None:
                self._learn_standing(*tor)  # first sighting: assume standing
            return None
        if tor is not None and not (RESCALE[0] < tor[2] / self.ref_torso < RESCALE[1]):
            # Stepped closer or further away: re-learn where "standing" is, and abandon any half-done rep.
            self.ref_hip_y = None
            self._learn_standing(*tor)
            self.machines["squat"].state = "up"
            return None
        drop = (hip_y - self.ref_hip_y) / self.ref_torso
        if standing and tor is not None and drop < HIP_UP:
            self._learn_standing(*tor)  # only learn while clearly standing, so a slow descent can't drag it down
        return self._smooth("squat_hip", drop)

    def counts(self) -> dict[str, int]:
        return {e: m.count for e, m in self.machines.items()}


def best_tilt(pts: list[Point]) -> float | None:
    """Torso tilt from horizontal using whichever side shows shoulder and hip (90 = upright)."""
    vals = [tilt_from_horizontal(pts[j["shoulder"]], pts[j["hip"]]) for j in SIDES.values() if pts[j["shoulder"]].ok and pts[j["hip"]].ok]
    return sum(vals) / len(vals) if vals else None
