// Solana DEVNET penalty transfer: escrow wallet -> charity wallet.
//
// Safety rules enforced here, not just by convention:
// - Devnet only: on connect we read the cluster's genesis hash and refuse anything that is not devnet,
//   whatever SOLANA_RPC_URL says.
// - The escrow secret key lives only in secrets/escrow-keypair.json (mode 600, gitignored). Nothing here prints it.
// - The amount is capped, and each day's transfer is signed once, saved, then sent, so a retry never pays twice.
//
// "Escrow" here is a server-held devnet wallet you pre-fund, not an on-chain escrow program.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  clusterApiUrl, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const MAX_PENALTY_SOL = 1; // sanity cap even on devnet
const FEE_BUFFER = 10_000; // lamports kept for the transaction fee
export const ESCROW_FILE = new URL('./secrets/escrow-keypair.json', import.meta.url);

export const explorerUrl = signature => `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
export const addressUrl = address => `https://explorer.solana.com/address/${address}?cluster=devnet`;

let connectionPromise;
/** A Connection that is proven to be devnet. */
export function devnet() {
  connectionPromise ??= (async () => {
    const url = process.env.SOLANA_RPC_URL || clusterApiUrl('devnet');
    const connection = new Connection(url, 'confirmed');
    const genesis = await connection.getGenesisHash();
    if (genesis !== DEVNET_GENESIS) throw new Error('Refusing to run: SOLANA_RPC_URL is not Solana devnet.');
    return connection;
  })().catch(err => { connectionPromise = undefined; throw err; });
  return connectionPromise;
}

export async function loadEscrow() {
  if (!existsSync(ESCROW_FILE)) throw new Error('No escrow wallet yet. Run: npm run wallet -- setup');
  const secret = Uint8Array.from(JSON.parse(await readFile(ESCROW_FILE, 'utf8')));
  return Keypair.fromSecretKey(secret);
}

/** Creates the escrow keypair file once. Returns only the public address. */
export async function createEscrowIfMissing() {
  if (existsSync(ESCROW_FILE)) return { created: false, address: (await loadEscrow()).publicKey.toBase58() };
  await mkdir(new URL('./secrets/', import.meta.url), { recursive: true, mode: 0o700 });
  const kp = Keypair.generate();
  await writeFile(ESCROW_FILE, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600, flag: 'wx' });
  await chmod(ESCROW_FILE, 0o600);
  return { created: true, address: kp.publicKey.toBase58() };
}

export function penaltyLamports() {
  const sol = Number(process.env.PENALTY_SOL || 0.05);
  if (!Number.isFinite(sol) || sol <= 0 || sol > MAX_PENALTY_SOL) throw new Error(`PENALTY_SOL must be between 0 and ${MAX_PENALTY_SOL}`);
  return Math.round(sol * LAMPORTS_PER_SOL);
}

export function charityAddress() {
  const raw = process.env.CHARITY_WALLET;
  if (!raw) throw new Error('CHARITY_WALLET is missing from .env.local');
  return new PublicKey(raw); // throws on a malformed address
}

/**
 * Sends (or finishes sending) one day's penalty. `prev` is the day's saved penalty record, if any; `save` persists
 * progress so a crash or retry never sends a second transfer for the same day.
 * @returns the final penalty record: status "confirmed" or "failed" (failed = nothing was paid)
 */
export async function payPenalty({ date, prev, save }) {
  if (prev?.status === 'confirmed') return prev;
  const connection = await devnet();

  // A transfer was signed and maybe sent before: find out what happened to it before doing anything else.
  // (A "failed" record means nothing was paid, so a retry starts a fresh transfer.)
  if (prev?.status === 'sending' && prev.signature) {
    const outcome = await settle(connection, prev);
    if (outcome) return save({ ...prev, ...outcome });
    // Still pending inside its blockhash window: wait for it rather than sending another.
    const done = await waitFor(connection, prev);
    return save({ ...prev, ...done });
  }

  const escrow = await loadEscrow();
  const to = charityAddress();
  const lamports = penaltyLamports();
  const balance = await connection.getBalance(escrow.publicKey);
  if (balance < lamports + FEE_BUFFER) {
    return save({ status: 'failed', error: `escrow underfunded: has ${balance / LAMPORTS_PER_SOL} SOL`, lamports, at: new Date().toISOString() });
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: escrow.publicKey, blockhash, lastValidBlockHeight })
    .add(SystemProgram.transfer({ fromPubkey: escrow.publicKey, toPubkey: to, lamports }))
    .add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`FaceTime coach: missed workout ${date}`) }));
  tx.sign(escrow);
  const signature = bs58.encode(tx.signature);

  // Save the signature BEFORE sending: if we crash after sending, the retry checks this signature instead of paying again.
  const record = await save({
    status: 'sending', signature, explorer_url: explorerUrl(signature), lamports, sol: lamports / LAMPORTS_PER_SOL,
    from: escrow.publicKey.toBase58(), to: to.toBase58(), last_valid_block_height: lastValidBlockHeight, at: new Date().toISOString(),
  });
  try {
    await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  } catch (err) {
    // Preflight rejected it: it never landed, so nothing was paid.
    return save({ ...record, status: 'failed', error: err.message.slice(0, 300) });
  }
  return save({ ...record, ...(await waitFor(connection, record)) });
}

async function settle(connection, rec) {
  const { value } = await connection.getSignatureStatus(rec.signature, { searchTransactionHistory: true });
  if (value?.err) return { status: 'failed', error: JSON.stringify(value.err) };
  if (value && (value.confirmationStatus === 'confirmed' || value.confirmationStatus === 'finalized')) return { status: 'confirmed', confirmed_at: new Date().toISOString() };
  const height = await connection.getBlockHeight('confirmed');
  // Expired without landing: it can never land now, so it is safe to treat as not paid.
  if (!value && height > rec.last_valid_block_height) return { status: 'failed', error: 'expired before landing (not paid)' };
  return null;
}

async function waitFor(connection, rec) {
  for (let i = 0; i < 90; i++) {
    const outcome = await settle(connection, rec);
    if (outcome) return outcome;
    await new Promise(r => setTimeout(r, 1000));
  }
  return { status: 'sending', error: 'not confirmed yet; retry later to re-check' };
}
