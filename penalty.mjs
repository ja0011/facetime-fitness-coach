// The penalty for a missed accountability call: devnet SOL escrow -> charity, then an iMessage with the link.
// Order matters: the transfer is recorded first, the text second, so a failed text never repeats or undoes a payment.
import { payPenalty } from './solana.mjs';
import { textOwner } from './imessage.mjs';

/**
 * @param {string} date YYYY-MM-DD
 * @param {(date: string) => any} getRecord reads the day's record from days.json state
 * @param {(date: string, fields: object) => Promise<any>} update merges fields into the record and saves days.json
 */
export async function applyPenalty(date, getRecord, update) {
  const rec = getRecord(date);
  if (rec?.outcome !== 'missed') return { skipped: `outcome is ${rec?.outcome ?? 'unknown'}, not missed` };

  // 1. Pay (idempotent: a confirmed penalty is never paid again).
  const penalty = await payPenalty({
    date,
    prev: rec.penalty,
    save: async p => (await update(date, { penalty: p })).penalty,
  });
  if (penalty.status !== 'confirmed') return { penalty };

  // 2. Text the explorer link (at most once successfully; a definite refusal can be retried with a new key).
  const prevNotify = getRecord(date).notify;
  if (prevNotify?.status === 'sent') return { penalty, notify: prevNotify };
  const attempt = (prevNotify?.attempt ?? 0) + (prevNotify?.status === 'refused' ? 1 : 0);
  const text = `You missed your workout call on ${date}, so ${penalty.sol} devnet SOL went from your escrow to charity.\n${penalty.explorer_url}`;
  const notify = { ...(await textOwner(text, `penalty-text-${date}-${attempt}`)), attempt };
  await update(date, { notify });
  return { penalty, notify };
}
