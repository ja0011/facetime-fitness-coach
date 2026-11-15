// SOL -> USD price for showing dollar amounts next to SOL (dashboard and the iMessage receipt).
// The penalties are devnet SOL (no real value); the USD figure is what the same amount of real SOL is worth.
// Public price APIs, no key. Cached 5 minutes; returns null if both are unreachable, and callers then show SOL only.

const TTL_MS = 5 * 60 * 1000;
let cache = { usd: null, at: 0 };

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function solUsd() {
  if (cache.usd && Date.now() - cache.at < TTL_MS) return cache.usd;
  const sources = [
    async () => (await fetchJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd')).solana.usd,
    async () => Number((await fetchJson('https://api.coinbase.com/v2/prices/SOL-USD/spot')).data.amount),
  ];
  for (const get of sources) {
    try {
      const usd = Number(await get());
      if (usd > 0) { cache = { usd, at: Date.now() }; return usd; }
    } catch {}
  }
  return cache.usd; // a stale price beats none
}

/** "$3.57" for an amount of SOL, or null without a price. */
export function formatUsd(sol, usd) {
  if (!(usd > 0) || sol == null) return null;
  const v = sol * usd;
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
