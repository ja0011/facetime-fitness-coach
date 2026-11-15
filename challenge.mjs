// Random workout per call, scaled to how long the caller has been sitting.
// Used by server.mjs (picks it when scheduling a call, saves it on the attempt) and agent.mjs (runs it).
//
// A challenge is { kind, walk, reps, exercise }:
//   walk = steps to walk (0 = no walk), reps = reps to do (0 = none), exercise = 'squat' | 'jumping_jack'.

export const DEMO_MODE = process.env.DEMO_MODE === '1';
export const INACTIVE_STEPS = Number(process.env.INACTIVE_STEPS || 250);
const ALLOW_JACKS = process.env.CHALLENGE_JACKS === '1'; // jumping jacks are off by default (less tested counter)

export const EXERCISE_WORDS = { squat: 'squats', pushup: 'push-ups', jumping_jack: 'jumping jacks' };

// [min, max] at the easiest and hardest end. Demo keeps everything small so a live demo finishes fast.
const RANGES = DEMO_MODE
  ? { walk: [10, 30], reps: [2, 5] }
  : { walk: [15, 60], reps: [2, 10] };

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * @param {{ stepsSince?: number | null }} [ctx] steps since the previous report (fewer = sat longer = harder)
 */
export function pickChallenge({ stepsSince = null, kind: wantKind = null } = {}) {
  // Severity 0..1: 0 steps since the last report = 1 (hardest); at the inactivity threshold = 0 (easiest).
  const severity = stepsSince == null ? 0.5 : clamp(1 - stepsSince / INACTIVE_STEPS, 0, 1);
  const sized = ([lo, hi], scale = 1) => {
    // Mostly set by severity, with a little randomness so two calls aren't identical.
    const t = clamp(severity + rand(-0.15, 0.15), 0, 1);
    return Math.max(lo, Math.round((lo + (hi - lo) * t) * scale));
  };
  const kinds = ['walk', 'reps', 'walk+reps'];
  // For testing: force the type ("walk", "squats"/"reps", "walk+squats"); the size is still random and scaled.
  const forced = { walk: 'walk', squats: 'reps', reps: 'reps', jacks: 'reps', 'walk+squats': 'walk+reps', 'walk+reps': 'walk+reps', both: 'walk+reps' }[wantKind];
  const kind = forced ?? kinds[Math.floor(Math.random() * kinds.length)];
  const exercise = wantKind === 'jacks' ? 'jumping_jack' : ALLOW_JACKS && !forced && Math.random() < 0.3 ? 'jumping_jack' : 'squat';
  // Both parts in one call: trim each a little so the pair still fits the 5-minute call cap.
  const both = kind === 'walk+reps';
  const walk = kind === 'reps' ? 0 : roundSteps(sized(RANGES.walk, both ? 0.7 : 1));
  const reps = kind === 'walk' ? 0 : sized(RANGES.reps, both ? 0.7 : 1);
  return { kind, walk, reps: Math.max(reps, kind === 'walk' ? 0 : RANGES.reps[0]), exercise, severity: Math.round(severity * 100) / 100 };
}

const roundSteps = n => Math.max(5, Math.round(n / 5) * 5);

/** "20 steps and 3 squats" */
export function describeChallenge(ch) {
  const parts = [];
  if (ch.walk > 0) parts.push(`${ch.walk} steps`);
  if (ch.reps > 0) parts.push(`${ch.reps} ${EXERCISE_WORDS[ch.exercise] ?? 'reps'}`);
  return parts.join(' and ') || 'a quick stretch';
}

/** "you've only taken 40 steps in the last hour" */
export function describeInactivity({ stepsSince, minutesSince } = {}) {
  if (stepsSince == null) return null;
  const mins = Math.round(minutesSince ?? 0);
  const span = mins >= 50 && mins <= 75 ? 'the last hour'
    : mins >= 90 ? `the last ${Math.round(mins / 60)} hours`
    : mins > 0 ? `the last ${mins} minutes` : 'a while';
  return `you've only taken ${stepsSince} steps in ${span}`;
}
