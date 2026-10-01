import { PublicKey } from '@solana/web3.js';
import { getOldestSignatures, parseTransactions, rpc, type EnhancedTx } from '../lib/helius.js';
import { dexPairsFor, type DexPair } from '../lib/market.js';
import { PUMP_PROGRAM } from '../lib/programs.js';
import { ScanInputError } from './types.js';

export interface MintInfo {
  program: 'spl-token' | 'spl-token-2022';
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  extensions: Array<{ extension: string; state?: Record<string, any> }>;
}

export interface DasAsset {
  id: string;
  interface: string;
  mutable: boolean;
  authorities?: Array<{ address: string; scopes: string[] }>;
  creators?: Array<{ address: string; verified: boolean }>;
  content?: {
    json_uri?: string;
    metadata?: { name?: string; symbol?: string; description?: string };
    links?: { image?: string; external_url?: string };
  };
}

export interface LaunchData {
  /** false when the mint has more history than we page through: early-block analysis is skipped */
  complete: boolean;
  totalSignatures: number;
  creationSlot: number | null;
  creationTime: number | null;
  creationFeePayer: string | null;
  early: EnhancedTx[];
}

export interface BondingCurve {
  address: string;
  exists: boolean;
  complete: boolean;
  realSolReserves: number;
  /** Set on curves created since pump.fun added the creator field. */
  creator: string | null;
}

const LAUNCH_MAX_PAGES = 3;
const EARLY_TX_COUNT = 60;

/** Per-scan memoised data shared across score blocks. */
export class ScanContext {
  private memo = new Map<string, Promise<unknown>>();
  constructor(public readonly mint: string) {}

  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = fn();
      this.memo.set(key, p);
    }
    return p;
  }

  mintInfo(): Promise<MintInfo> {
    return this.once('mint', async () => {
      const res = await rpc<{ value: any }>('getAccountInfo', [this.mint, { encoding: 'jsonParsed' }]);
      const v = res.value;
      if (!v) throw new ScanInputError('Account not found on mainnet', 404);
      const parsed = v.data?.parsed;
      if (!parsed || parsed.type !== 'mint') throw new ScanInputError('Address is not an SPL token mint', 422);
      const info = parsed.info;
      return {
        program: v.data.program,
        mintAuthority: info.mintAuthority ?? null,
        freezeAuthority: info.freezeAuthority ?? null,
        supply: BigInt(info.supply),
        decimals: info.decimals,
        extensions: info.extensions ?? [],
      };
    });
  }

  asset(): Promise<DasAsset | null> {
    return this.once('asset', () => rpc<DasAsset>('getAsset', { id: this.mint }).catch(() => null));
  }

  dexPairs(): Promise<DexPair[]> {
    return this.once('dex', async () =>
      (await dexPairsFor([this.mint])).filter((p) => p.baseToken.address === this.mint || p.quoteToken.address === this.mint),
    );
  }

  bondingCurve(): Promise<BondingCurve> {
    return this.once('curve', async () => {
      const [pda] = PublicKey.findProgramAddressSync(
        [Buffer.from('bonding-curve'), new PublicKey(this.mint).toBuffer()],
        new PublicKey(PUMP_PROGRAM),
      );
      const address = pda.toBase58();
      const res = await rpc<{ value: { data: [string, string]; owner: string } | null }>('getAccountInfo', [
        address,
        { encoding: 'base64' },
      ]);
      if (!res.value || res.value.owner !== PUMP_PROGRAM)
        return { address, exists: false, complete: false, realSolReserves: 0, creator: null };
      const buf = Buffer.from(res.value.data[0], 'base64');
      // layout: 8 discriminator | virtualToken u64 | virtualSol u64 | realToken u64 | realSol u64 | supply u64
      //         | complete bool | creator pubkey (newer curves)
      const creator = buf.length >= 81 ? new PublicKey(buf.subarray(49, 81)).toBase58() : null;
      return {
        address,
        exists: true,
        realSolReserves: Number(buf.readBigUInt64LE(32)) / 1e9,
        complete: buf[48] === 1,
        creator: creator === PublicKey.default.toBase58() ? null : creator,
      };
    });
  }

  launch(): Promise<LaunchData> {
    return this.once('launch', async () => {
      const { oldestFirst, total, complete } = await getOldestSignatures(this.mint, LAUNCH_MAX_PAGES);
      if (!complete || !oldestFirst.length) {
        return { complete: false, totalSignatures: total, creationSlot: null, creationTime: null, creationFeePayer: null, early: [] };
      }
      const early = (await parseTransactions(oldestFirst.slice(0, EARLY_TX_COUNT).map((s) => s.signature))).sort(
        (a, b) => a.slot - b.slot,
      );
      const first = early[0];
      return {
        complete: true,
        totalSignatures: total,
        creationSlot: first?.slot ?? oldestFirst[0].slot,
        creationTime: first?.timestamp ?? oldestFirst[0].blockTime,
        creationFeePayer: first?.feePayer ?? null,
        early,
      };
    });
  }

  /** Token creator: unverified DAS creator, pump.fun curve creator, or the creation fee payer. */
  creator(): Promise<string | null> {
    return this.once('creator', async () => {
      const [asset, curve] = await Promise.all([this.asset(), this.bondingCurve().catch(() => null)]);
      const known = asset?.creators?.[0]?.address ?? curve?.creator;
      if (known) return known;
      const launch = await this.launch().catch(() => null);
      return launch?.creationFeePayer ?? null;
    });
  }
}

export const uiAmount = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;
