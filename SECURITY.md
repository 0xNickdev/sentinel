# Security

Sentinel sits between an AI agent and money. This document describes what it protects, what it assumes and how to report a problem.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report privately through [GitHub Security Advisories](https://github.com/0xNickdev/sentinel/security/advisories/new) with steps to reproduce and the impact you observed. We aim to acknowledge reports within 72 hours.

## Trust model

| Component | Holds | Can it move funds? |
|---|---|---|
| Agent | Its own key, a member of the guarded multisig with Initiate + Execute | Only through a proposal that received a vote |
| Sentinel gateway | No keys. Returns unsigned transactions | No |
| Sentinel guard key | Vote-only member of the multisig | No. It cannot create proposals |
| Owner | Full-permission member | Yes, always, without Sentinel |
| Squads v4 program | Enforces the vote threshold on-chain | Enforcement only |

## Threats and mitigations

| Threat | Mitigation |
|---|---|
| Prompt injection makes the agent drain the wallet | Bastion simulates the transfer; draining ≥ 90% of the balance or exceeding 5× the limit triggers a persistent freeze. On a guarded wallet nothing executes without Sentinel's vote. |
| Agent bypasses Sentinel and proposes directly in Squads | The agent has no vote; the Squads program rejects execution (`InvalidProposalStatus`). Verified on devnet. |
| Drainer instructions hidden inside a transaction | Token approvals to strangers, token-account owner changes and wallet reassignment are blocked regardless of policy, including inside inner (CPI) instructions. |
| Rug pull or honeypot token | Scan blocks critical flags (active mint/freeze authority, dangerous Token-2022 extensions, no sell route, no real liquidity) and scores below the policy threshold. |
| Sentinel's guard key leaks | It can only vote. An attacker also needs a proposal from the agent or owner, and the owner can remove Sentinel at any time. |
| Sentinel is offline | The agent is blocked, the owner is not: the owner keeps full control of the multisig. |
| Replay of an unfreeze signature | Unfreeze messages are bound to the wallet and cluster and expire after 10 minutes. |
| Forged Telegram webhook calls | Requests must carry the secret token Telegram echoes; others get `401`. |
| Upstream data source failure | The affected scoring block degrades to half weight with an `insufficient_data` flag. It never produces a false "allow". |
| Abuse of the public API | Per-IP rate limits shared across instances through Postgres. |

## Known limitations

- Scan weights are calibrated on a limited set of tokens; treat scores as risk indicators, not guarantees.
- Early-block analysis runs only when a mint's history is short enough to reach its creation within the time budget.
- LP lock is verified only for the pump.fun curve and PumpSwap.
- Policies on the plain (non-guarded) gateway are advisory to the agent; on-chain enforcement requires a guarded wallet.

Scores and decisions are risk indicators, not financial advice.
