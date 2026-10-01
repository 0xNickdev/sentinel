import { AsyncLocalStorage } from 'node:async_hooks';

export type Cluster = 'mainnet' | 'devnet';

const store = new AsyncLocalStorage<Cluster>();

/** Cluster for the current request. Scan and market data are mainnet-only; devnet exists for testing the guard. */
export const currentCluster = (): Cluster => store.getStore() ?? 'mainnet';

export const withCluster = <T>(cluster: Cluster, fn: () => Promise<T>): Promise<T> => store.run(cluster, fn);

export const parseCluster = (v: unknown): Cluster => (v === 'devnet' ? 'devnet' : 'mainnet');
