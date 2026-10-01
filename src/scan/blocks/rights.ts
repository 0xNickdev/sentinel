import type { ScanContext } from '../context.js';
import { BlockBuilder } from './util.js';

const ESTABLISHED_LIQUIDITY_USD = 250_000;
const ESTABLISHED_AGE_MS = 90 * 86_400_000;

/** Authorities: mint / freeze authority, mutable metadata, dangerous Token-2022 extensions. Weight 15. */
export async function rightsBlock(ctx: ScanContext) {
  const b = new BlockBuilder('rights', 'Authorities', 15);
  const [mint, asset, pairs, longHistory] = await Promise.all([ctx.mintInfo(), ctx.asset(), ctx.dexPairs().catch(() => []), ctx.longHistory().catch(() => false)]);
  let pts = 15;
  // Protocol and DAO tokens keep mint/freeze authority on purpose (treasury, emissions). For a token that has
  // traded for months with deep liquidity this is a governance fact, not a rug signal.
  const liquidity = pairs.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const firstListed = Math.min(...pairs.map((p) => p.pairCreatedAt ?? Infinity));
  // Mature = deep liquidity plus either months of trading or a history longer than we page through on-chain.
  const established = liquidity >= ESTABLISHED_LIQUIDITY_USD && (Date.now() - firstListed >= ESTABLISHED_AGE_MS || longHistory);
  const authority = established ? 'warn' : 'critical';

  b.details = {
    established,
    program: mint.program,
    mintAuthority: mint.mintAuthority,
    freezeAuthority: mint.freezeAuthority,
    metadataMutable: asset?.mutable ?? null,
    extensions: mint.extensions.map((e) => e.extension),
  };

  if (mint.mintAuthority) {
    pts = established ? pts - 6 : 0;
    b.flag('mint_authority_active', authority, established
      ? 'Mint authority is active (established token, typically held by a DAO or treasury)'
      : 'Mint authority is active, so more supply can be minted at any time');
  }
  if (mint.freezeAuthority) {
    pts -= established ? 4 : 8;
    b.flag('freeze_authority_active', authority, established
      ? 'Freeze authority is active (established token, typically held by the issuer)'
      : 'Freeze authority is active, so your tokens can be frozen (honeypot)');
  }
  if (asset?.mutable) {
    pts -= 3;
    b.flag('metadata_mutable', 'warn', 'Metadata can be changed after you buy');
  }

  for (const ext of mint.extensions) {
    const s = ext.state ?? {};
    switch (ext.extension) {
      case 'permanentDelegate':
        if (s.delegate) {
          pts = 0;
          b.flag('permanent_delegate', 'critical', 'Token-2022 permanent delegate can take tokens from any wallet');
        }
        break;
      case 'nonTransferable':
        pts = 0;
        b.flag('non_transferable', 'critical', 'Token is non-transferable and cannot be sold');
        break;
      case 'pausableConfig':
        if (s.authority) {
          pts = 0;
          b.flag('pausable', 'critical', 'Token transfers can be paused');
        }
        break;
      case 'defaultAccountState':
        if (s.accountState === 'frozen') {
          pts = 0;
          b.flag('default_frozen', 'critical', 'New accounts are created frozen');
        }
        break;
      case 'transferHook':
        if (s.programId) {
          pts -= 5;
          b.flag('transfer_hook', 'warn', `Transfer hook calls an external program ${s.programId}`);
        }
        break;
      case 'transferFeeConfig': {
        const bps = Number(s.newerTransferFee?.transferFeeBasisPoints ?? s.olderTransferFee?.transferFeeBasisPoints ?? 0);
        b.details.transferFeeBps = bps;
        if (bps >= 500) {
          pts -= 5;
          b.flag('high_transfer_fee', 'warn', `Transfer fee ${bps / 100}%`);
        } else if (bps > 0) {
          b.flag('transfer_fee', 'info', `Transfer fee ${bps / 100}%`);
        }
        break;
      }
      case 'mintCloseAuthority':
        if (s.closeAuthority) {
          pts -= 2;
          b.flag('mint_close_authority', 'warn', 'Mint can be closed');
        }
        break;
    }
  }

  if (!asset) b.status = 'partial';
  b.score = pts;
  return b.build();
}
