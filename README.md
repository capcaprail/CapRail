# CapRail

Cap table of a private company on Solana, where the shareholder agreement is
enforced by the token itself. The equity token is a Token-2022 mint with a
transfer hook: every transfer — from the panel, from a script, from any wallet —
runs the company's policy and investor registry on chain, and a transfer to a
wallet that is not admitted is refused by the network, atomically, with the
reason in the transaction logs. The cap table is read from the chain, not
maintained by hand.

Two programs serve every issuer. `caprail` holds state and actions: company,
token, policy, registry, distribution from the treasury (later grants and
offers). `caprail-hook` is the rule: Token-2022 calls it on each
`transfer_checked`, and it only reads what `caprail` writes. A company's policy
is data in an account — changing it takes one transaction, not a reissue.

## What v0.1.0 does

- Create a company and issue its equity token (a company can have more than
  one). The token is a Token-2022 mint with on-chain metadata; the whole supply
  is minted once into the company treasury and the mint authority is revoked —
  there is no "mint more" instruction. There is no freeze authority either: the
  rule is the hook, not freezing.
- Set the transfer policy: whether the recipient needs a valid admission. The
  ROFR flag exists in the policy but is refused by the program until ROFR is
  implemented — "ROFR on, no mechanism" is not a state the chain can be in.
- Keep the investor registry, per token: wallet, admission status, expiry,
  jurisdiction and investor type (the last two are informational; transfers are
  not blocked on them). The same wallet in two companies is two records.
- Distribute tokens from the treasury — through the same hook as any other
  transfer.
- Refuse a transfer to a wallet that is not in the registry, whose admission has
  expired or was revoked — balances of both sides unchanged, reason in the logs
  (`NotAccredited`, `AccreditationExpired`). A revoked holder keeps what they
  already hold and cannot receive more. The rule checks the recipient: a
  transfer back to the company treasury always passes, and a policy that does
  not require admission lets every transfer through.
- Show the live cap table and the transfer journal in the company panel, fed by
  an indexer: chain → worker → Postgres → API → event stream.

Not in this version: the secondary market with offers (v0.2), vesting (v0.3),
right of first refusal (v0.4), the compliance report (v0.5). The investor
cabinet and the market screens in the panel are prototypes on mock data until
then, and say so. Admission status is set by a person inside the product; there
is no external KYC. The demo proves that the rule is enforced by the network,
not where the status came from.

## Roles

Roles are wallets, and they are separated in the program, not in the UI.

| Role | Can | Cannot |
|---|---|---|
| **Admin** | create the company and the token, set the policy, assign roles, distribute from the treasury | change admission statuses |
| **Compliance officer** | set, extend and revoke admission statuses in the registry | change the policy, issue or distribute tokens |
| **Investor** | hold tokens, send them to another admitted wallet | receive without a valid admission |

One person can be admin and officer, with two different keys. The platform
holds no keys: every state change is an on-chain instruction signed by the
role's wallet in the browser. The API only reads the index and records
simulation reports.

## Layout

```
programs/caprail        state and actions (Anchor)
programs/caprail-hook   the transfer rule (Anchor, transfer hook interface)
packages/chain          vendored IDL, PDAs, transaction builders, hook account resolution
packages/indexer        parser of program events and hook refusals from transaction logs
packages/db             Drizzle schema, migrations, row-level security
packages/shared         schemas shared by API and web
apps/worker             follows the chain and fills the index
apps/api                Hono: wallet sign-in, company reads, SSE feed, simulation reports
apps/web                React panel: company wizard, policy, registry, distribute, cap table, journal
tools/demo              the US1 story as a script, with the measurements behind the numbers below
fixtures                recorded transaction logs for the parser; the hook's account list, cross-checked between program and client
scripts                 build, local validator, deploy and trace sweep (WSL)
```

## Running locally

Both programs are deployed on devnet at the addresses in `packages/chain`
(`As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g` and
`6EMZVfUkf2wrtwfnESLghWfdWyzDu71uJTJ7dCKG3YEi`). To run the panel you need
nothing on chain — only Node 22+, pnpm 9.15, a Postgres database (a Supabase
project works as is) and a devnet RPC endpoint.

```bash
pnpm install
cp .env.example .env                    # fill in the values marked REPLACE_ME
pnpm --filter @caprail/db db:migrate    # schema, policies and the read-only role
pnpm dev                                # api :8787, worker, web :5173
```

Then open `http://localhost:5173`, connect a wallet that is on devnet and has
some devnet SOL, sign in, and create a company.

About `.env`:

- `DATABASE_URL` is the transaction pooler (`:6543`); `MIGRATE_DATABASE_URL` is
  the session pooler (`:5432`) and is used by `db:migrate` only. Both connect as
  `postgres`; the API switches to the `caprail_api` role per request, so
  row-level security applies to what the panel reads.
- `DEVNET_RPC_URL` / `DEVNET_WS_URL` are the node the worker follows. The public
  devnet node rate-limits the worker and the panel from one address — a keyed
  endpoint (Helius or similar, devnet subdomain) is what the numbers below were
  measured on.
- `VITE_*` values are baked into the web bundle and are public by construction.
- `JWT_SECRET` — at least 32 bytes of randomness.

`pnpm gate` runs what CI runs on the TypeScript side: IDL check, lint,
typecheck, tests.

### Programs

Rebuilding the programs needs Linux or WSL with the Rust toolchain from
`rust-toolchain.toml`, Agave 3.1.10 and Anchor 1.2.0. From PowerShell:

```powershell
wsl.exe -e bash /mnt/<drive>/<path-to-repo>/scripts/wsl-build.sh <build-sbf|idl|test|clippy|gate>
```

The artefact that goes to the network is the `cargo-build-sbf` one (SBPFv0):
`anchor build` produces SBPFv3, which Agave 3.1.10 does not execute, and writes
it to the same `.so`. `idl` builds the IDL; `pnpm idl:sync` vendors it into
`packages/chain`, and `pnpm idl:check` in the gate fails when the vendored copy
drifts from the build (it is skipped where there is no `target/`). Program
tests run the real `.so` under `mollusk-svm` in `cargo test`, including a compute-unit gate for the hook. A local validator with
both programs in genesis (`scripts/wsl-localnet.sh`) and deployment
(`scripts/wsl-deploy.sh`) require the program keypairs, which are not in the
repository.

The CLI demo tells the whole story — company → token → policy → two admitted
investors → distribution → a transfer between investors passes → a transfer to a
stranger, sent without preflight, is refused by the network — and measures it:

```bash
pnpm demo:us1                                                           # local validator
pnpm demo:us1 -- --rpc devnet --payer <keypair.json> --api http://localhost:8787
```

The exit code is the verdict.

### The panel on GitHub Pages

`.github/workflows/pages.yml` builds `apps/web` on every push to `main` and
publishes it as a project site at `https://<owner>.github.io/<repo>/`. The api
and the worker are not static and are hosted separately; the panel reaches the
api through `VITE_API_URL`. Once, in the repository settings:

- **Settings → Pages → Build and deployment → Source: GitHub Actions.**
- **Settings → Secrets and variables → Actions → Variables:** `VITE_API_URL`
  (required — the api's public origin; the build fails without it),
  `VITE_DEVNET_RPC_URL` (optional; the node the panel sends transactions to —
  it is public in the bundle, so no key; default: the public devnet node),
  `PAGES_BASE_PATH` = `/` only for a custom domain.
- On the api, `WEB_ORIGIN` must include the Pages origin
  (`https://<owner>.github.io`), or the browser blocks every request with CORS.

Pages has no rewrites: a deep link is served `404.html`, which is a copy of the
app shell, and the router takes over from there — the document status of such
a load is 404, which is expected. Locally, `BASE_PATH=/<repo>/ pnpm --filter
@caprail/web build` reproduces the Pages build.

## Wallets — what to know

- Sign-in is a signed message (one-time nonce, 5 minutes; the session token
  lives one hour). The wallet must support message signing; some hardware
  wallet paths connect but cannot sign in.
- The panel builds each transaction itself, attaches the hook's accounts,
  simulates it, and only then asks the wallet to sign — a transfer the network
  would refuse is shown as refused without a signature prompt, and is recorded
  in the journal as a `simulation`; refusals that reached the chain are `chain`.
  Wallets register through Wallet Standard (Phantom, Solflare, Backpack); the
  wallet has to be switched to devnet.
- A transfer started from a wallet's own send screen is checked by the same
  rule — if the wallet attaches the transfer hook's extra accounts
  (Token-2022 `ExtraAccountMetaList`). A wallet that does not resolve them fails
  before the rule runs: the network never sees the transfer, so neither does the
  journal. That is a property of the wallet, not of the token.
- The sender pays the base fee (5 000 lamports per transfer, measured). The
  recipient's token account is created by whoever sends first — for a
  distribution that is the admin, about 0.002 SOL of rent.

## Measured on devnet (v0.1.0)

| | Budget | Measured |
|---|---|---|
| Transfers to a non-admitted wallet refused | 100 of 100, balances unchanged | 100 of 100 |
| Transfers to an admitted wallet passed | ≥ 99 of 100 | 100 of 100 |
| Cap table updated after confirmation | ≤ 5 s p95 | 1.45 s p95 |
| Refusal in the journal with the right reason | ≤ 5 s p95 | 1.14 s p95 |
| End-to-end demo | ≤ 3 min | 18.7 s |
| Cost of a compliant transfer to the sender | ≤ 0.001 SOL | 0.000005 SOL |
| Status change applies to the next transfer | ≤ 10 s | ≤ 20 slots (≈ 4 s) |

Numbers come from `pnpm demo:us1 -- --rpc devnet --api …`; latencies are from
the client's confirmation to the event on the panel's stream, p95 over 100
transfers and 100 refusals.
