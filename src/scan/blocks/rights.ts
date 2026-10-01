import type { ScanContext } from '../context.js';
import { BlockBuilder } from './util.js';

/** Authorities: mint / freeze authority, mutable metadata, dangerous Token-2022 extensions. Weight 15. */
export async function rightsBlock(ctx: ScanContext) {
  const b = new BlockBuilder('rights', 'Authorities', 15);
  const [mint, asset] = await Promise.all([ctx.mintInfo(), ctx.asset()]);
  let pts = 15;

  b.details = {
    program: mint.program,
    mintAuthority: mint.mintAuthority,
    freezeAuthority: mint.freezeAuthority,
    metadataMutable: asset?.mutable ?? null,
    extensions: mint.extensions.map((e) => e.extension),
  };

  if (mint.mintAuthority) {
    pts = 0;
    b.flag('mint_authority_active', 'critical', 'Mint authority is active, so more supply can be minted at any time');
  }
  if (mint.freezeAuthority) {
    pts -= 8;
    b.flag('freeze_authority_active', 'critical', 'Freeze authority is active, so your tokens can be frozen (honeypot)');
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
