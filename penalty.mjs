// The penalty for one call attempt: devnet SOL escrow -> charity, then an iMessage with the link.
// Charged when the outcome is "missed" (phone rang, not answered) or "failed" (answered, walk target not reached).
// Order matters: the transfer is recorded first, the text second, so a failed text never repeats or undoes a payment.
// Idempotent per attempt (one attempt = one Chert call_id): a confirmed penalty is never paid again.
import { payPenalty } from './solana.mjs';
import { textOwner } from './imessage.mjs';

export const CHARGEABLE = new Set(['missed', 'failed']);

/**
 * @param {{ date: string, attempt: object, get: () => object, save: (fields: object) => Promise<object> }} opts
 *   get() re-reads the attempt; save() merges fields into it and persists days.json.
 */
export async function applyPenalty({ date, attempt, get, save }) {
  if (!CHARGEABLE.has(attempt.outcome)) return { skipped: `outcome is ${attempt.outcome ?? 'unknown'}` };
  const key = attempt.call_id || attempt.id;
  const label = attempt.outcome === 'failed'
    ? `walk not finished ${date} call ${key.slice(0, 8)}`
    : `missed call ${date} call ${key.slice(0, 8)}`;

  // 1. Pay.
  const penalty = await payPenalty({
    date,
    label,
    prev: attempt.penalty,
    save: async p => (await save({ penalty: p })).penalty,
  });
  if (penalty.status !== 'confirmed') return { penalty };

  // 2. Text the explorer link (at most once successfully; a definite refusal can be retried with a new key).
  const prevNotify = get().notify;
  if (prevNotify?.status === 'sent') return { penalty, notify: prevNotify };
  const n = (prevNotify?.attempt ?? 0) + (prevNotify?.status === 'refused' ? 1 : 0);
  const why = attempt.outcome === 'failed'
    ? `You answered but stopped at ${attempt.walk?.progress ?? 0} of ${attempt.walk?.target ?? '?'} steps`
    : 'You missed your workout call';
  const text = `${why}, so ${penalty.sol} devnet SOL went from your escrow to charity.\n${penalty.explorer_url}`;
  const notify = { ...(await textOwner(text, `penalty-text-${key}-${n}`)), attempt: n };
  await save({ notify });
  return { penalty, notify };
}
