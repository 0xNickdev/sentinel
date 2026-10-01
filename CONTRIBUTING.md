# Contributing

Thanks for helping make agent wallets safer.

## Development

```bash
npm install
cp .env.example .env   # HELIUS_API_KEY is enough to start
npm run dev            # watch mode on http://127.0.0.1:8787
```

Before opening a pull request:

```bash
npm run typecheck
npm run e2e            # gateway scenarios on mainnet data, simulation only
```

Changes to the guard should also pass `npm run guard:devnet` (real devnet transactions; needs a funded devnet wallet in `OWNER_SECRET`).

## Guidelines

- **Scoring rules are versioned.** Any change to Scan weights or thresholds bumps `RULES_VERSION`; Bastion changes bump `BASTION_RULES_VERSION`. Explain the reasoning and the tokens you tested on.
- **Never trade correctness for a green verdict.** When data is missing, degrade and say so; do not guess "allow".
- **No keys in code.** Configuration comes from environment variables only.
- **User-facing messages** are short, concrete and name the risk, for example "Freeze authority is active, so your tokens can be frozen (honeypot)".
- Use [Conventional Commits](https://www.conventionalcommits.org): `feat(scan): ...`, `fix(guard): ...`, `docs: ...`.

## Reporting security issues

Do not file public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
