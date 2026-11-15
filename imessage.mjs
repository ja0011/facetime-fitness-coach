// Text the owner over iMessage from the Chert shared line (POST /api/v1/shared-messages, project API key).
// Trial limit: the line may only text a phone that texted it within the last 24 hours. A refusal is returned,
// not thrown, so a failed text never undoes or repeats a penalty.
const BASE = process.env.CHERT_MESSAGES_API || 'https://app.trychert.com/api/v1';

/**
 * @param {string} text
 * @param {string} idempotencyKey 8-200 characters; the same key never sends twice
 * @returns {Promise<{ status: 'sent' | 'refused' | 'unknown', http_status?: number, error?: string, at: string }>}
 */
export async function textOwner(text, idempotencyKey) {
  const at = new Date().toISOString();
  let res;
  try {
    res = await fetch(`${BASE}/shared-messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.CHERT_API_KEY}`,
        'x-chert-project-id': process.env.CHERT_PROJECT_ID,
        'idempotency-key': idempotencyKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ line_id: process.env.CHERT_LINE_ID, recipient: process.env.MY_PHONE, text }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // No response: it may or may not have been sent. Reuse the same key to find out; never switch keys blindly.
    return { status: 'unknown', error: err.message, at };
  }
  const body = await res.text();
  let json; try { json = JSON.parse(body); } catch { json = null; }
  if (res.ok) return { status: 'sent', http_status: res.status, state: json?.data?.state ?? json?.state ?? null, at };
  const error = json?.error?.code || json?.error?.message || json?.code || json?.error || body.slice(0, 200);
  return { status: res.status >= 500 ? 'unknown' : 'refused', http_status: res.status, error: typeof error === 'string' ? error : JSON.stringify(error), at };
}
