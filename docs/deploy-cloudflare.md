# Deploying to Cloudflare — the click-path

Everything here happens in **your** Cloudflare and Google dashboards. None of it can be done
from the repository, so this is written as an ordered click-path rather than as prose. The
code being deployed is [`store/`](../store/README.md) and [`ops/`](../ops/README.md).

End state:

| Hostname | Serves | Deployed from | Gate |
|---|---|---|---|
| `vemians.com`, `www.vemians.com` | `vemians-storefront` — the real catalog | pushes to `main` | none |
| `staging.vemians.com` | `vemians-storefront-staging` — a SEPARATE Worker running whatever is on the `staging` branch | pushes to `staging` | none |
| `ops.vemians.com` | The Worker's employee area | pushes to `main` | Cloudflare Access → One-time PIN |

> **`staging.vemians.com` is a separate Worker, deliberately**, not a second Custom Domain on
> `vemians-storefront`. The whole point of a staging branch is that a change under test cannot
> reach the domain customers see; two Custom Domains on one running Worker cannot promise that —
> whatever code is deployed answers both names identically. So `store/wrangler.staging.toml`
> deploys its own Worker (`vemians-storefront-staging`), attached to `staging.vemians.com` by
> `.github/scripts/setup-domains.py` automatically on every push to `staging`. It binds the SAME
> `CATALOG_MIRROR` D1 database as production — there is one real catalog, mirrored once, and
> both Workers only ever read it — so staging differs from production in **code**, never in a
> second copy of the data. `vemians.com` and `www.vemians.com` stay the manual, by-hand
> attachments described in §3 below.

> **The apex points at our Worker, not at Shopify.** `cloudflare-architecture.md` §3 carries a
> superseded note about grey-clouding `A @ 23.227.38.65` and `CNAME www shops.myshopify.com`
> because Shopify does not support Cloudflare's proxy. That constraint is real but **does not
> apply here** — nothing points at a Shopify-hosted storefront. Checkout, when it exists, lives
> on `<store>.myshopify.com` and needs no DNS record in this zone. Reach for that note only if
> a Shopify-hosted storefront is ever reintroduced at the apex.

---

## 1. Put the zone on Cloudflare

1. <https://dash.cloudflare.com> → **Add a site** → `vemians.com` → **Continue**.
2. Choose the **Free** plan unless you already know you need otherwise. See §8.
3. Cloudflare scans the existing DNS and shows you what it found. **Check this list before
   continuing** — anything it missed (mail, verification `TXT` records, subdomains) is
   offline the moment the nameservers move. Add what is missing now.
4. Cloudflare gives you **two nameservers**, e.g. `xxx.ns.cloudflare.com`.
5. Go to the registrar where `vemians.com` is registered → the domain's nameserver settings →
   replace the existing nameservers with Cloudflare's two. Remove the old ones entirely; a
   mixed set fails intermittently, which is worse than failing.
6. Back in Cloudflare, **Check nameservers now**. Propagation is usually minutes but the
   registrar may take up to 24 hours. The zone shows **Active** when it is done.

Confirm from a terminal:

```sh
dig +short NS vemians.com          # should return the two Cloudflare nameservers
```

Do not continue until the zone is Active. A Workers Custom Domain cannot be created on a zone
Cloudflare does not hold, and `wrangler deploy` will fail with a fairly opaque error.

## 1b. Namecheap and Gmail — the specific path

Namecheap keeps DNS in **two places**, and this is where domains lose their mail:

- **Domain List → Manage → the NAMESERVERS panel** — decides *who answers* for the domain.
- **Domain List → Manage → Advanced DNS tab** — the records themselves, served **only while
  the nameservers are Namecheap's**.

Switching the first to Custom DNS makes the second stop being served **entirely and
instantly**. The records are not migrated, not merged, and not consulted again. Whatever is on
the Advanced DNS tab has to exist in Cloudflare before you flip it.

### Before you touch anything

1. Open **Advanced DNS** and screenshot the whole table. Every row.
2. Run the capture, which reaches records the tab can hide from a screenshot:

   ```sh
   ./tools/dns-preflight.sh capture vemians.com
   ```

3. If **Email Forwarding** is set up on that tab, note it — it is a Namecheap feature and it
   stops working when the nameservers leave. Gmail is unaffected; forwarding is not.

### The Gmail records that must survive

Copy these into Cloudflare **exactly as they are now**. All are `TXT` unless marked.

| Record | Name | What it does | If lost |
|---|---|---|---|
| `MX` | `@` | Delivers your mail | **Mail bounces immediately** |
| SPF | `@` | `v=spf1 include:_spf.google.com ~all` | Your mail lands in spam |
| Verification | `@` | `google-site-verification=…` | Workspace may unverify the domain |
| DKIM | `google._domainkey` | Signs outgoing mail | Mail lands in spam |
| DMARC | `_dmarc` | Handling policy | Weakened deliverability |

**Your MX will be one of two shapes. Copy the one you have — do not switch to the other
during this migration.**

Since April 2023 Google issues a single record:

| Priority | Value |
|---|---|
| 1 | `smtp.google.com` |

Domains set up before then use five, all still fully supported and routing to identical
infrastructure:

| Priority | Value |
|---|---|
| 1 | `aspmx.l.google.com` |
| 5 | `alt1.aspmx.l.google.com` |
| 5 | `alt2.aspmx.l.google.com` |
| 10 | `alt3.aspmx.l.google.com` |
| 10 | `alt4.aspmx.l.google.com` |

Both work. Migrating from five to one is a fine thing to do **on a different day** — doing it
now means changing your nameservers and your mail routing at once, and if mail breaks you will
not know which caused it. One variable at a time.

### Two Cloudflare-specific traps

**MX records must be grey-cloud.** Cloudflare cannot proxy mail. An MX pointing at a proxied
record is a broken mail server. Cloudflare normally gets this right on import — check anyway.

**DKIM is long, and long TXT records break.** A DKIM key exceeds the 255-character limit for a
single TXT string, so it is stored split. Import sometimes mangles the split. After the move,
compare it character-for-character against the capture rather than glancing at it.

### Making the switch

**Domain List → Manage → NAMESERVERS → dropdown → Custom DNS**, then enter Cloudflare's two
nameservers and save with the green tick. Remove any others; a mixed set fails intermittently,
which is harder to diagnose than failing outright.

### Confirm mail, not just the website

```sh
./tools/dns-preflight.sh verify vemians.com
```

Then **send an email to yourself from an outside address** — a phone on mobile data, a personal
account. `dig` proves the record resolves; only a delivered message proves mail works. Do this
before you go to bed on the day you switch.

---

## 2. Deploy the Worker

From a clone, in `store/`:

```sh
npx wrangler login          # opens a browser, authorises this machine against your account
npx wrangler deploy
```

That publishes `vemians-storefront` on its `*.workers.dev` URL. Open it and confirm the
catalog renders before attaching any hostname — if something is wrong, it is much easier to
see here than behind a domain and a gate.

## 3. Deploy two Workers and attach their domains

**Two Workers, not one.** Cloudflare Access attaches to a *whole Worker*, with no way to scope
it to one route inside it. A single Worker serving both surfaces therefore cannot be gated on
the employee area and open on the shop — switching Access on would put a login page in front of
customers.

Each surface is its own package with its own `wrangler.toml`, so the ops code is not in the
storefront bundle at all. `SURFACE` pins each deployment on top of that, and either Worker
refuses to serve if it is pinned to the other surface, whatever `Host` header arrives:

```sh
( cd store && npx wrangler deploy )   # vemians-storefront   SURFACE=public   no Access
( cd ops   && npx wrangler deploy )   # vemians-ops          SURFACE=ops      Access on
```

Then attach Custom Domains — **Custom Domains, not Routes**; a Custom Domain creates and
manages the proxied DNS record, and it is what Access can sit in front of.

**Workers & Pages → `vemians-storefront` → Settings → Domains & Routes → Add → Custom domain**

- `vemians.com`
- `www.vemians.com`

**Workers & Pages → `vemians-ops` → … → Add → Custom domain**

- `ops.vemians.com`

`staging.vemians.com` is **not** added here — leave it out. It attaches itself the first time
`deploy-workers.yml` runs on a push to the `staging` branch (`.github/scripts/setup-domains.py`),
pointed at `vemians-storefront-staging`, a Worker of its own — not either one above.

Each takes a minute or two to issue a certificate. In **DNS → Records** confirm all three show
as orange-cloud (proxied). Delete any stale `A` or `CNAME` for those names that survived the
import — a leftover record fighting a Custom Domain fails confusingly.

`vemians-ops` refuses every request with **401** until §5–6 are done, because no Access
assertion reaches it. That is the correct resting state, not a fault.

## 4. Turn on Zero Trust and pick a team name

1. Dashboard → **Zero Trust** (left sidebar). First visit walks you through creating an
   organisation.
2. Choose a **team name**, e.g. `vemians`. This becomes your team domain,
   `vemians.cloudflareaccess.com`, and it is a nuisance to change later — it is the issuer in
   every token and the hostname of every login page.
3. Choose the **Free** plan. Card details are requested even on Free. See §8.

## 5. Pick a login method

Access needs one identity provider. Two options; the Worker cannot tell them apart, because it
only ever verifies the Access JWT — **swapping later needs no code change**.

### Option A — One-time PIN **(chosen)**

**No external setup, no dashboard other than Cloudflare's own.** It is enabled on a new Zero
Trust organisation already. Anyone reaches `ops.vemians.com`, enters their own email, Cloudflare
sends a 6-digit code, they are in. Who is actually *allowed* in is entirely the Access policy in
§6 — not the login method, and not a shared company domain, since **everyone has their own
address**: the policy (and the Access Groups in §6b) list individual emails one at a time,
never an `email_domain` rule.

**Skip to §6.** That is the whole step.

What you give up, deliberately: no true single sign-on and no directory groups to derive roles
from automatically — it is an email and a code each time a session expires, and roles come from
**Access Groups** instead (§6b), a hand-maintained list rather than something a directory
updates on its own. That trade is the whole point: it needs no Google Workspace (or any other
directory) behind it at all, and one person having their own Workspace, or none, or five, never
matters to who can sign in here.

**Optional: reskin the page itself.** The login page is served entirely by Cloudflare, not by
this codebase — there is no HTML here to edit for it, and the customisation ceiling is real:
**Zero Trust → Settings → Custom Pages** (Cloudflare has reorganised this navigation before; look
for "Login page" or "Branding" under Settings if it has moved again) offers a background colour
and a logo image, on Cloudflare's own fixed layout. No custom HTML, no font, no button colour, no
password field — One-time PIN has no password to ask for.

- **Background colour**: `#191817` — `--ground`, the actual page background behind `.shell` and
  the iframe content (`ops/src/views.js`), a warm near-black, **not pure black**. `--bar`
  (`#000000`, true black) is a different, narrower token: it colours only the thin header strip
  the tabs sit in, not the page itself — using it here would visibly mismatch the surface it's
  meant to match.
- **Logo**: upload one if you have it. Nothing in this repository ships a logo file today; supply
  your own image (a square mark fits Cloudflare's fixed layout best).

### Option B — Google Workspace SSO (not used — history only)

**This was the original plan and is no longer how this deploys.** It required every staff email
to sit in a directory Cloudflare could query for group membership, which assumed one shared
Workspace behind the staff domain. That assumption broke — staff each hold their own,
independent email address (some with their own Workspace, some without) — so the whole
approach was dropped in favour of Option A. Kept below only so old Access configuration makes
sense if you ever find a leftover Google Workspace login method still attached to the
application; it should be **removed**, not maintained, once Option A above is confirmed working.

<details>
<summary>Original Google Workspace steps, for reference only</summary>

Two dashboards, and the order matters because each needs a value from the other.

**In Google Cloud Console** (<https://console.cloud.google.com> — *not* admin.google.com;
OAuth clients live in Cloud Console), signed in as a Workspace **super administrator**:

1. Create a project, or pick an existing one — e.g. `vemians-sso`.
2. **APIs & Services → Library** → enable the **Admin SDK API**. This is what lets Cloudflare
   read group membership; without it you get authentication but no groups, and the whole
   "roles derive from Workspace groups" design (PRD `Test-PRD-P0-23-group_derived_roles`) does
   not work. Moot under Option A anyway: One-time PIN carries no group claims at all, so
   `explainRole()` (`ops/src/access.js`) derives the role from the Access **policy_id** instead —
   see §6b, which is the path actually in use.
3. **APIs & Services → OAuth consent screen** → User type **Internal** → fill in app name and
   support email → Save.
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Name: `Cloudflare Access`
   - **Authorised JavaScript origins**: `https://vemians.cloudflareaccess.com`
   - **Authorised redirect URI**:
     `https://vemians.cloudflareaccess.com/cdn-cgi/access/callback`
     (substitute your own team name from §4 — Cloudflare also shows you this exact URI on the
     login-method form in the next step, so copy it from there if in any doubt.)
5. Save, and keep the **Client ID** and **Client secret**. The secret is shown once.

**In Cloudflare Zero Trust** → **Settings → Authentication → Login methods → Add new →
Google Workspace**:

- **App ID** — the Client ID from step 5
- **Client secret** — the Client secret from step 5
- **Google Admin email** — a Workspace **super admin** address, e.g. `you@vemians.com`.
  Cloudflare uses it to query the Admin SDK for groups.

Save, then **Test**. A successful test opens a Google sign-in and returns a green result
listing your email and groups. If groups come back empty, step 2 is the thing to check.

</details>

## 6. Create the Access application for `ops.vemians.com`

**Zero Trust → Access controls → Applications → Add an application.**

Choose the **Workers** application type and select **`vemians-ops`**. Access applies to the
whole Worker, which is exactly why §3 deploys two: `vemians-storefront` is a separate Worker
with no application on it, so the shop stays open.

*(Cloudflare has reorganised this navigation more than once. If the type list differs, you
want the one that targets a Worker or a self-hosted web application — not SaaS/SSO app, which
makes Cloudflare an identity provider for third-party software, and not Service Auth, which is
machine-to-machine.)*

1. **Application name**: `Vemians ops`
2. **Session duration**: 24 hours is a reasonable start.
3. **Target**: the `vemians-ops` Worker (equivalently, hostname `ops.vemians.com` — it must
   match the Custom Domain from §3 exactly).
4. **Identity providers**: tick **One-time PIN**, and untick **Accept all available identity
   providers** so nothing else can be used.
5. Next → **Add policy**:
   - **Policy name**: `Vemians staff`
   - **Action**: **Allow**
   - **Include** → one **Emails** rule per address, listing every current staff member
     individually — not **Emails ending in**, since there is no shared company domain to match.

   `.github/scripts/setup-access.mjs` (run via the `setup-access` workflow, input
   `staff_emails`, one address per line or comma-separated) does exactly this for you and is
   idempotent, so re-running it as staff changes is the normal way to maintain this policy
   rather than editing it by hand every time. Leave Require and Exclude empty. Later, tighter
   surfaces — `identity`, `people`, `finance` — get their **own applications and their own
   policies** with an **Access Group** Include (§6b) rather than the whole staff list
   (PRD `Test-PRD-P0-24-binding_scoped_tools`).
6. Save. Then open **Overview** on the finished application and copy the **Application
   Audience (AUD) tag** — a 64-character hex string.

**Now close the loop in the code.** In `ops/wrangler.toml`, uncomment and fill:

```toml
ACCESS_TEAM_DOMAIN = "vemians.cloudflareaccess.com"
ACCESS_AUD         = "<the 64-char AUD tag>"
```

then `npx wrangler deploy`. Until you do this the Worker still fails closed on a missing
assertion, but it accepts any well-formed one **without checking its signature**, and says so
in a black banner across the top of the ops page. Access is the gate either way; this makes
the Worker verify that the request really came through it.

## 6b. Roles without a directory — Access Groups

The staff policy in §6 makes every named address equal. That is fine for reaching `ops` at all
and wrong for `identity`, `finance` and `people`, which the PRD scopes to owner and manager
(`Test-PRD-P0-24-binding_scoped_tools`).

With One-time PIN there is no directory to derive roles from, so use **Cloudflare Access
Groups** — named, reusable sets of emails, defined once and referenced by any policy. Every
Include below is **individual addresses, never a domain rule** — staff each hold their own,
independent email.

**Zero Trust → Access → Groups → Add a group:**

| Group | Include |
|---|---|
| `vemians-owner` | Emails → the owner's own address |
| `vemians-staff` | Emails → every staff member's own address, one Include per person |
| `vemians-manager` | Not created until someone actually holds the role — a group that exists to look complete, holding nobody, is a lie the next person has to disprove |

`.github/scripts/setup-roles.py` (run via the `setup-roles` workflow, inputs `owner_email` and
`staff_emails`) creates the first two groups from a plain list of addresses — it is idempotent
by group name, so re-running it after adding a group by hand leaves that group untouched rather
than overwriting it. `.github/scripts/setup-policies.py` (the `setup-policies` workflow, no
inputs) then points one Access policy at each group, ordered owner-before-staff so precedence
can't silently demote the owner, and prints the two policy IDs this needs next.

**Close the loop in `ops/wrangler.toml`** — `ops/src/access.js`'s `explainRole()` reads the
Access assertion's `policy_id` (what One-time PIN actually carries; there are no group claims
to read directly) and maps it to a role via these three vars:

```toml
OWNER_POLICY_ID  = "<the 'Vemians owner' policy id, from setup-policies>"
STAFF_POLICY_ID  = "<the 'Vemians staff by group' policy id, from setup-policies>"
# MANAGER_POLICY_ID stays unset until a vemians-manager group and policy actually exist.
```

Then each tighter surface (`identity`, `people`, `finance`) gets **its own Access application**
on its own hostname or path, with the appropriate group as the Include. Adding or removing
someone is one edit in one group, not a policy change in several applications.

---

## 7. Test both surfaces — and test the refusal

Testing that it works is half the job. Testing that it refuses is the other half, and it is
the half people skip.

**Public catalog — must be open to everyone:**

```sh
curl -sI https://vemians.com/            # HTTP/2 200
curl -sI https://www.vemians.com/        # HTTP/2 200
```

Then open <https://vemians.com> in a **private window** with no Cloudflare cookies. The grid
should render for an anonymous visitor with no login prompt of any kind. If you get redirected
to a `cloudflareaccess.com` login page, your Access application's hostname in §6.3 is too
broad — check it is `ops.vemians.com` and not `vemians.com` or `*.vemians.com`.

**The employee area — must be gated:**

```sh
curl -sI https://ops.vemians.com/        # HTTP/2 302, location: https://vemians.cloudflareaccess.com/...
```

A `302` to your team domain is Access doing its job. A `200` means the request reached the
Worker without passing Access, and the application is not the thing that will save you — go
back to §6.3.

Then in a browser: <https://ops.vemians.com> → enter a listed staff email → Cloudflare emails a
6-digit code → enter it → the ops page loads, with your email shown at the top and the black
"without signature verification" banner **gone** if you completed §6.

**Prove the refusal — do all three:**

1. **An address not on any policy.** Open a private window, go to `https://ops.vemians.com`,
   enter an email that is not in the `Vemians staff` policy's Include list. Access must show its
   own denial page — *"That account does not have access"* — and you must never see the ops
   page, and no code should even be worth trying. The refusal comes from Cloudflare, before the
   Worker runs at all. That is the point.
2. **Logged out.** `https://vemians.cloudflareaccess.com/cdn-cgi/access/logout` clears the
   session; reload `ops.vemians.com` and you are back at the login page.
3. **No unauthenticated twin.** `curl -sI https://vemians.com/ops` must return **404**. The
   employee area exists only on the gated hostname; if this ever returns 200 there is a copy
   of it outside the gate.

**Prove offboarding works** (PRD §10, and worth doing once deliberately): remove a test
address from the `Vemians staff` policy's Include (or the `vemians-staff` Access Group it
draws from, per §6b), then have them try to sign in again. Access refuses on the next session
check with no change on our side — there is no directory admin console in this picture at all,
just the policy/group Include. Zero Trust → **My Team → Users → Revoke sessions** forces an
already-signed-in session out immediately rather than waiting for it to expire.

## 8. What costs money, and where the limits bite

| Thing | Free tier | When you pay |
|---|---|---|
| **Cloudflare zone** (DNS, proxy, TLS) | Free plan is enough for all of the above | Pro ($20+/mo) buys WAF rules, image optimisation, better analytics. Not needed to ship this |
| **Workers** | 100,000 requests/day, 10 ms CPU per invocation | **Workers Paid, $5/mo**: 10 M requests, 30 s CPU, and it is also the plan that unlocks Durable Objects and higher D1 limits. Expect to need it at launch, not before |
| **Cloudflare Access** | **50 users**, all features, all identity providers, One-time PIN included | **$7 per user per month beyond 50 seats.** Not a concern at shop scale, but it is a per-seat cost, so it is the line item that grows with headcount |
| **Custom Domains on Workers** | Included, any plan | — |
| **D1** (not used by the prototype) | 5 GB, 5 M rows read/day | Workers Paid raises the ceilings substantially |
| **R2, Cloudflare Images** (not used yet) | R2 has 10 GB storage and **no egress fee**; Images is paid from the first transform | Images is ~$5/mo per 100k transforms. Budget it with the media work, not now |

Two limits worth knowing before they surprise you:

- **Access is billed per user, not per application.** Splitting `identity`, `people` and
  `finance` into their own applications and policies (§6.5) costs nothing extra.
- **The Workers free tier is per-account per-day, not per-Worker.** One noisy crawler on the
  public catalog can exhaust it, and the failure mode is a `1027` error page for everyone.
  If the storefront is genuinely public, take the $5 plan.

## 9. Order of operations, condensed

1. Add zone, move nameservers, wait for **Active**.
2. `npx wrangler login && npx wrangler deploy`; check the `workers.dev` URL renders.
3. Add three Custom Domains: apex, `www`, `ops`.
4. Zero Trust org + team name. One-time PIN is already enabled — no external identity provider
   to configure.
5. Access application on `ops.vemians.com`, identity provider **One-time PIN**, policy
   **Allow / Include / Emails** — one Include per staff address (`setup-access` workflow,
   input `staff_emails`) — copy the AUD tag.
6. Fill `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.toml`, redeploy.
7. Run `setup-roles` (`owner_email`, `staff_emails`) then `setup-policies` to create the
   owner/staff Access Groups and the precedence-ordered policies deriving roles from
   `policy_id`; copy `OWNER_POLICY_ID`/`STAFF_POLICY_ID` into `wrangler.toml`, redeploy.
8. Test the catalog anonymously, test the ops sign-in (email → PIN code), then **test all
   three refusals**.
