# Deploying without a local machine

`wrangler` needs a computer. If you do not have one set up, GitHub Actions is one — it runs on
GitHub's infrastructure, reads a token from repository secrets, and deploys for you.

This is also the right answer to "can I just hand over my API key". You should not paste a
Cloudflare token into a chat, and you do not need to: a secret in this repository is readable
by workflow runs and by nothing else.

## 1. Make a scoped token

<https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → **Create Custom Token**.

**Do not use "Edit Cloudflare Workers" or a Global API Key.** Both grant far more than
deploying needs, and this token lives in CI where its blast radius is whatever you gave it.

| Permission | Level | Access | Why |
|---|---|---|---|
| Workers Scripts | Account | Edit | Upload the two Workers |
| Workers KV Storage | Account | Edit | Only when the `APPROVALS` KV binding is added |
| D1 | Account | Edit | Apply migrations to the six stores |
| Account Settings | Account | Read | `wrangler` resolves the account |

Scope **Account Resources** to your account alone, and set an **expiry** — a year is
reasonable; a token with no expiry is a credential you will forget you issued.

Copy the token once. Cloudflare will not show it again.

Your **Account ID** is on the right-hand side of any zone's Overview page.

## 2. Put both in repository secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

- `CLOUDFLARE_API_TOKEN` — the token
- `CLOUDFLARE_ACCOUNT_ID` — the account id

Secrets are write-only from the UI. Nobody, including an agent working in this repository, can
read them back; workflow runs receive them and logs redact them.

## 3. Run it

Repo → **Actions → deploy-workers → Run workflow**. Pick `both`, `storefront` or `ops`.

The workflow runs the tests and the schema checks **before** it deploys. A red deploy is worse
than a red test, because by the time you find out it is already live.

On success both Workers are on their `*.workers.dev` URLs immediately — no DNS, no zone, no
Custom Domain. That is the fastest way to see the site on real Cloudflare infrastructure.

It also runs automatically on every push to `main` that touches `store/**`, `ops/**` or `shared/**`.

## What this does not do

**Create the D1 databases.** Run once, from anywhere with the token — including a one-off
`workflow_dispatch` if you have no terminal:

```sh
for s in customers identity commerce people finance audit tickets; do
  npx wrangler d1 create "vemians-$s"
done
```

Then paste each returned `database_id` into `wrangler.toml`.

**Attach Custom Domains.** A dashboard step, done once; it survives every later deploy.

**Configure Cloudflare Access.** Also dashboard-only. Until the Access application exists,
`vemians-ops` correctly refuses every request with 401 — no assertion is reaching it. That is
the resting state, not a fault.

**Set `ANTHROPIC_API_KEY`.** A Worker secret rather than a repository secret:

```sh
npx wrangler secret put ANTHROPIC_API_KEY --env ops
```

Without it the agent falls back to its echo stub and says so on screen, so nothing breaks.
