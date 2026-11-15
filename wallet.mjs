// Devnet wallet setup. Prints public addresses and balances only, never secret keys.
//   npm run wallet -- setup         create the escrow wallet (once), then try a devnet airdrop
//   npm run wallet -- balance       escrow and charity balances
//   npm run wallet -- airdrop [SOL] request devnet SOL for the escrow (faucet is rate-limited)
//   npm run wallet -- new-charity   make a throwaway devnet address to use as CHARITY_WALLET
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { addressUrl, createEscrowIfMissing, devnet, loadEscrow } from './solana.mjs';

const log = obj => console.log(JSON.stringify(obj));
const [cmd = 'balance', arg] = process.argv.slice(2);

async function airdrop(connection, pubkey, sol) {
  try {
    const sig = await connection.requestAirdrop(pubkey, Math.round(sol * LAMPORTS_PER_SOL));
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
    log({ airdrop: 'ok', sol });
  } catch (err) {
    log({ airdrop: 'failed', error: err.message.slice(0, 200), fallback: `Fund it at https://faucet.solana.com (choose Devnet) with address ${pubkey.toBase58()}` });
  }
}

async function balances(connection) {
  const escrow = (await loadEscrow()).publicKey;
  const out = { escrow: escrow.toBase58(), escrow_sol: (await connection.getBalance(escrow)) / LAMPORTS_PER_SOL, escrow_explorer: addressUrl(escrow.toBase58()) };
  if (process.env.CHARITY_WALLET) {
    const charity = new PublicKey(process.env.CHARITY_WALLET);
    Object.assign(out, { charity: charity.toBase58(), charity_sol: (await connection.getBalance(charity)) / LAMPORTS_PER_SOL, charity_explorer: addressUrl(charity.toBase58()) });
  }
  log(out);
}

try {
  if (cmd === 'new-charity') {
    // Devnet stand-in for a charity. Its secret key is thrown away: we only ever need to send to it.
    log({ charity_wallet: Keypair.generate().publicKey.toBase58(), next: 'Put this in .env.local as CHARITY_WALLET=...' });
  } else {
    const connection = await devnet(); // throws unless the RPC is really devnet
    log({ cluster: 'devnet (genesis hash verified)' });
    if (cmd === 'setup') {
      const { created, address } = await createEscrowIfMissing();
      log({ escrow: address, created, keyfile: 'secrets/escrow-keypair.json (mode 600, gitignored)' });
      if ((await connection.getBalance(new PublicKey(address))) < 0.5 * LAMPORTS_PER_SOL) await airdrop(connection, new PublicKey(address), 1);
      await balances(connection);
    } else if (cmd === 'airdrop') {
      await airdrop(connection, (await loadEscrow()).publicKey, Number(arg || 1));
      await balances(connection);
    } else {
      await balances(connection);
    }
  }
} catch (err) {
  log({ error: err.message });
  process.exitCode = 1;
}
