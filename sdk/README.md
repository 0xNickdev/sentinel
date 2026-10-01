# clawpump-sentinel

A security gateway between your AI agent and its Solana wallet. Before anything is signed, Sentinel scans the token, simulates the transaction and applies the owner's policies. Built for the ClawPump ecosystem.

```bash
npm i clawpump-sentinel @solana/web3.js
```

## One line for the agent

```ts
import { Sentinel } from 'clawpump-sentinel';
import { Connection, Keypair } from '@solana/web3.js';

const sentinel = new Sentinel({ policy: { limits: { per_tx_sol: 2, per_day_sol: 10 } } });

const res = await sentinel.executeAndSend(
  { type: 'buy', wallet: agent.publicKey.toBase58(), mint: '<token CA>', sol: 0.5 },
  agent,        // Keypair: the agent signs, Sentinel never sees the key
  connection,
);

if (res.decision !== 'allow') console.log('Not sent:', res.reasons.map((r) => r.message));
```

`executeAndSend` signs and sends only when the decision is `allow`. Anything else comes back unsigned with the reasons:

| decision | meaning |
|---|---|
| `allow` | passed every check, signed and sent |
| `confirm` | needs the owner's approval first |
| `block` | failed a check, for example a rug token or an over-limit trade |
| `freeze` | the kill-switch fired, for example a drain attempt |

## Guarded wallets (on-chain enforcement)

A guarded wallet is a Squads multisig where the agent can only propose, Sentinel can only approve and the owner keeps full control. The agent cannot move funds without Sentinel's vote, even if it is compromised.

```ts
// Owner, once:
const setup = await sentinel.guard.setup({ owner, agent, fundSol: 1 });
// sign setup.transaction with the owner wallet and send it
// open setup.telegramLink to get approval requests and kill-switch alerts

// Agent, per trade: propose + execute in one call
const run = await sentinel.guard.run(
  { multisig: setup.multisig, intent: { type: 'buy', agent: agentKey.publicKey.toBase58(), mint, sol: 0.5 } },
  agentKey,
  connection,
);
run.executed;     // true when Sentinel approved and it ran
run.approvalUrl;  // set when the owner must approve
```

## Other calls

```ts
await sentinel.scan(mint);                       // 0-100 risk score with flags
await sentinel.execute(intent);                  // decision + unsigned transaction
await sentinel.check(myTransaction, { wallet }); // judge a transaction you built
await sentinel.guard.status(multisig);           // members, balance, frozen?
await sentinel.journal({ wallet });              // decision log
```

Prefer MCP? Connect `https://sentinel-clawpump.vercel.app/api/mcp` as a custom connector.

Scores and decisions are risk indicators, not financial advice.
