# CapRail

Cap table of a private company on Solana, where the shareholder agreement is
enforced by the token itself. The equity token is a Token-2022 mint with a
transfer hook: every transfer — from the panel, from a script, from any wallet —
runs the company's policy and investor registry on chain, and a transfer to a
wallet that is not admitted is refused by the network, atomically, with the
reason in the transaction logs. The cap table is read from the chain, not
maintained by hand.

**Live:** the site <https://capcaprail.github.io/CapRail/> and the panel at
<https://capcaprail.github.io/CapRail/app/>, on Solana devnet.

Two programs serve every issuer. `caprail` holds state and actions: company,
token, policy, registry, distribution from the treasury, the platform and its
offers (later grants). `caprail-hook` is the rule: Token-2022 calls it on each
`transfer_checked`, and it only reads what `caprail` writes. A company's policy
is data in an account — changing it takes one transaction, not a reissue.

## What v0.2.0 does

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

New in v0.2.0 — a secondary market that checks the buyer before the match:

- A holder offers shares at a fixed price per share, from the investor cabinet.
  The shares are not escrowed: they stay in the seller's wallet, delegated to the
  offer, one open offer per account. The seller can cancel at any time.
- An offer is visible only to wallets that would pass admission for that token
  right now — the same check the hook makes, mirrored by the index. Everyone else
  sees an empty storefront.
- Accepting takes the whole offer or part of it in one transaction: shares to
  the buyer through the hook, payment to the seller, the platform fee to the fee
  treasury — all of it or none of it. The form shows what the buyer pays, the fee
  and what the seller receives before signing, computed with the same formula the
  program charges.
- A buyer whose admission is revoked after the offer was posted is refused by the
  network before any balance moves.
- An offer the seller's account no longer backs in full — shares moved away,
  delegation withdrawn — is marked stale, with the reason and how much can still
  be taken, on the storefront and in the company's book. The network would refuse
  the excess anyway.
- The company panel lists every offer of its tokens (open, filled, cancelled) and
  shows each trade in the transfer journal with its price, payment and fee; both
  update live.
- The platform (fee in basis points, payment mint, fee treasury) is configured
  once per deployment by an offline key. On devnet the fee is 100 bps and the
  payment token is a demo stablecoin, `dUSD`.

Not in this version: vesting (v0.3), right of first refusal (v0.4), the
compliance report (v0.5). Admission status is set by a person inside the
product; there is no external KYC. The demo proves that the rule is enforced by
the network, not where the status came from. The payment token is a demo mint,
not USDC.

## Roles

Roles are wallets, and they are separated in the program, not in the UI.

| Role | Can | Cannot |
|---|---|---|
| **Admin** | create the company and the token, set the policy, assign roles, distribute from the treasury | change admission statuses |
| **Compliance officer** | set, extend and revoke admission statuses in the registry | change the policy, issue or distribute tokens |
| **Investor** | hold tokens, send them to another admitted wallet, offer shares for sale, accept an offer | receive or buy without a valid admission, see offers of tokens it is not admitted to |

One person can be admin and officer, with two different keys. The platform
holds no keys at runtime: every state change is an on-chain instruction signed
by the role's wallet in the browser. The one key outside wallets is the
platform authority, used once, offline, to set the fee and the payment mint. The API only reads the index and records
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
apps/landing            the static landing page at the site root (no build, no JavaScript)
tools/demo              the US1 and US2 stories as scripts, with the measurements behind the numbers below
fixtures                recorded transaction logs for the parser; the hook's account list, cross-checked between program and client
scripts                 build, local validator, deploy and trace sweep (WSL)
```

## Running locally

Both programs are deployed on devnet at the addresses in `packages/chain`
(`As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g` and
`6EMZVfUkf2wrtwfnESLghWfdWyzDu71uJTJ7dCKG3YEi`). To run the panel you need
nothing on chain — only Node 26, pnpm 9.15, a Postgres database (a Supabase
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
- `DEVNET_RPC_URL` / `DEVNET_WS_URL` are the node the worker follows; the API
  reads `DEVNET_RPC_URL` too, once, for the platform fee it quotes. The public
  devnet node rate-limits the worker and the panel from one address — a keyed
  endpoint (Helius or similar, devnet subdomain) is what the numbers below were
  measured on.
- `PAYMENT_SYMBOL` (optional) labels the payment mint in prices — `dUSD` for the demo
  stablecoin, which carries no on-chain metadata. Unset, the panel shows the mint's
  address instead of a symbol it might not be.
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

The market story runs the same first half, then: an offer, a partial accept with
the fee checked against what the chain charged, a buyer revoked after the offer
refused before any balance moves, a cancel, a whole accept. The platform is set
up once per deployment by its offline key, which also issues the demo stablecoin
that pays the buyers:

```bash
pnpm demo:init-platform -- --authority <keypair.json>                   # once
pnpm demo:us2 -- --authority <keypair.json>
```

The exit code is the verdict.

### The site on GitHub Pages

`.github/workflows/pages.yml` publishes a project site on every push to `main`:
the landing page (`apps/landing`, copied as is) at `https://<owner>.github.io/<repo>/`
and the panel (`apps/web`, built) under `https://<owner>.github.io/<repo>/app/`.
The api and the worker are not static and are hosted separately; the panel
reaches the api through `VITE_API_URL`. Once, in the repository settings:

- **Settings → Pages → Build and deployment → Source: GitHub Actions.**
- **Settings → Secrets and variables → Actions → Variables:** `VITE_API_URL`
  (required — the api's public origin; the build fails without it),
  `VITE_DEVNET_RPC_URL` (optional; the node the panel sends transactions to —
  it is public in the bundle, so no key; default: the public devnet node),
  `PAGES_BASE_PATH` = `/app/` only for a custom domain (the panel's base; the
  landing is always the site root).
- On the api, `WEB_ORIGIN` must include the Pages origin
  (`https://<owner>.github.io`), or the browser blocks every request with CORS.

Pages has no rewrites and serves a custom 404 only from the site root: a deep
link into the panel is served the root `404.html`, which is a copy of the panel's
shell, and the router takes over from there — the document status of such a load
is 404, which is expected. Links from before the panel moved under `app/`
(`/<repo>/company/…`, `/<repo>/market`) reach the same shell, and the panel moves
them under `app/` before its router starts. Locally, `BASE_PATH=/<repo>/app/ pnpm
--filter @caprail/web build` reproduces the Pages build of the panel.

### The api and the worker on Render

`render.yaml` is a Render Blueprint: one free web service runs the api with the
worker inside it (`RUN_WORKER=true` — the free plan has no background workers),
in Frankfurt next to the Supabase project. Once, in the Render dashboard:

- **New → Blueprint →** this repository. Render reads `render.yaml`, generates
  `JWT_SECRET`, and asks for the values marked `sync: false`: `DATABASE_URL`
  (transaction pooler, `:6543`), `DEVNET_RPC_URL` and `DEVNET_WS_URL` (a keyed
  devnet node — the key stays in Render, never in the panel's bundle),
  `WEB_ORIGIN` (the Pages origin, `https://<owner>.github.io`), and optionally
  `DEVNET_RPC_FALLBACK_URL`.
- The service lives at `https://caprail-api.onrender.com` (or the name Render
  gives it); that origin is the `VITE_API_URL` of the Pages build. Every push to
  `main` redeploys it.
- Run `pnpm --filter @caprail/db db:migrate` from a checkout **before** pushing a
  commit that changes the schema: the service does not migrate on start.

The process starts the worker first and binds the port after its first backfill,
so `/health` answering means the index has caught up with the chain.

A free service sleeps after 15 minutes without HTTP and takes about a minute to
wake. Nothing is lost while it sleeps — the worker reads on from its cursor — but
the first visitor waits. Keep it awake with an external monitor, not a GitHub
Actions schedule (GitHub thins a `*/5` schedule out to once in hours):

- **UptimeRobot** (free): a monitor of type HTTP(s) on
  `https://<service>.onrender.com/health`, every 5 minutes. It also tells the
  owner when the service is down.

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

## Measured

On devnet, v0.1.0:

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

v0.2.0, the market and the hosting:

| | Budget | Measured |
|---|---|---|
| Trades where one side moved without the other | 0 of 100, 20 broken on purpose | 0 (program tests) |
| Offers matched to non-admitted buyers | 0 of 200, stopped before balances move | 0 (program tests) |
| Fee shown before accepting = fee charged | equal | equal: quote = `OfferAccepted.fee` = the four balance moves, partial and whole (devnet) |
| Cap table updated after confirmation, hosted | ≤ 5 s p95 | 0.74 s p95 |
| Refusal in the journal, hosted | ≤ 5 s p95 | 0.80 s p95 |
| End-to-end demo, hosted | ≤ 3 min | 22.6 s |
| `accept_offer` compute | < 240 000 CU (its limit) | 98 000–120 000 CU on devnet |

The hosted rows are `pnpm demo:us1 -- --rpc devnet --api https://caprail-api.onrender.com`,
20 transfers and 20 refusals, on 3 October 2026; the market rows are
`pnpm demo:us2 -- --rpc devnet --authority …` and `cargo test` (mollusk).
