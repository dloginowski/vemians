# PRD — Vemians Platform

| | |
|---|---|
| **Status** | Draft for review |
| **Last updated** | 2026-09-08 |
| **Owner** | dimitri@handsome.la |
| **Supersedes** | the single-Postgres / Shopify-hosted-storefront draft |
| **Decided in** | [ADR-001](./adr/001-catalog-storage.md) · [ADR-002](./adr/002-data-domains.md) · [ADR-003](./adr/003-sharding-and-customer-data.md) · [ADR-004](./adr/004-customer-data-protection.md) · [ADR-006](./adr/006-encrypted-storage-vendor.md) |

---

## 1. Synopsis

Vemians runs on a storefront and an operations layer we own outright, with commerce
providers reduced to pluggable sales channels.

There is no central database. Data is split into **nine stores by blast radius and
retention**, not by topic — three in Git, six in D1. **Catalog, knowledge and reports live
in Git** (versioned, reviewable, publishable, no PII); **customers, identity, commerce,
people, finance and audit live in D1** (concurrent, erasable, constraint-enforcing). Nothing joins across a
store boundary — cross-store references are an id plus a snapshot.

Customer identifiers — name, email, phone — exist in exactly one place, the `identity`
store, as **ciphertext under application-level envelope encryption with the KEK held in an
external KMS**, so neither provider alone can read a customer record. Hashing was
considered and rejected: low-entropy inputs are brute-forced in seconds, and re-identifiable
data is still personal data. Everything else keys off an opaque customer id.

Reversibility — "employees edit freely, nothing is destroyed, changes revert like a commit"
— comes from an **append-only `customer_version` log**, not from Git immutability. Git gives
undo by making history permanent, and that permanence is exactly what forecloses erasure.
The log gives the same undo while leaving deletion possible. Deleting a customer profile
therefore really deletes it, while the orders survive intact and anonymous for tax retention.

Staff reach `ops.vemians.com` through **Cloudflare Access**, which terminates identity before
a request reaches our code. The gate is **Google Workspace SSO**. The provider remains a
configuration choice rather than an architectural one — the Worker only verifies the Access
JWT, which is identical whichever provider issued it — but Workspace is the decision, because
it gives directory groups for role scoping. Tool scope is enforced by per-store bindings, not
by prompt.

Staff reach those tools two ways, and both hit the same tool layer: the **browser chat** at
`ops.vemians.com`, and a **remote MCP endpoint** for people using their own AI client. Some
staff use Claude, some use ChatGPT; that is a per-person preference, not an architectural
commitment. The storefront is **ours** — Astro on Workers, our design system, a
resolution-adaptive grid and 8:9 imagery — and calls a provider only to mint a checkout URL.
**Checkout is deliberately rented**: PCI scope, fraud and tax are the one accepted dependency,
and Shopify and POS are both channels behind the same commerce port.

Provider independence is not asserted, it is executed: **the Exit Test runs in CI** and blocks
merge.

---

## 2. Goals

**G1 — Own the system of record.** Catalog, content, knowledge, orders, customers,
employees and schedules live in stores we control. A commerce provider holds a *copy*.

**G2 — Provider independence, proven not promised.** Removing a provider must not touch a
store, the storefront, or the design. Verified by the Exit Test in CI (§7).

**G3 — A beautiful storefront we control.** Design and front-end code are ours, no vendor
theming layer.

**G4 — Agentic operations at `ops.vemians.com`**, behind Cloudflare Access.

**G5 — Customer data we can actually delete.** Erasure obligations are a design input, not
a policy document.

**G6 — Minimal moving parts.** Nine stores, one commerce port, no infrastructure the
storefront does not need.

---

## 3. P0 features

Every numbered feature carries a stable label. Tests enforce these features by label; a test
that does not trace to one of these is a process failure (see §12).

### 3.1 Data topology

1. **`Test-PRD-P0-01-store_topology`** — Nine stores, none central: `catalog`, `knowledge`
   and `reports` in Git; `customers`, `identity`, `commerce`, `people`, `finance` and `audit`
   in D1. (Six in ADR-002, grown by ADR-003's `reports` and `customers` split and ADR-004's
   `identity` vault.) Each D1 store is an independent schema and an independent binding, loads and
   migrates on its own, and holds **no foreign key and no transaction** reaching another
   store. Cross-store references are `id` plus a snapshot of what was needed.
2. **`Test-PRD-P0-02-catalog_git_shards`** — The catalog is JSON in Git, one file per entity
   (`catalog/products/<handle>.json`), so a product edit is a one-file diff and two agent PRs
   do not conflict. The index is **derived at build time and never committed** — it is a
   cache, not a source. One writer per file.
3. **`Test-PRD-P0-03-knowledge_git_vectorize`** — The knowledge library is Markdown in Git.
   Semantic search is a **derived index** in Vectorize, embedded on commit and rebuildable
   from Git at any time. If the index disagrees with Git, Git wins.
4. **`Test-PRD-P0-04-reports_git_shards`** — Reports are JSON in Git, sharded by period
   (`reports/2026-Q3.json`). No PII may enter any Git store.

### 3.2 Customer data protection

5. **`Test-PRD-P0-05-identity_vault`** — Direct identifiers (name, email, phone) exist **only**
   in the `identity` store and **only as ciphertext**. Encryption is application-level
   envelope encryption: a per-customer data key encrypts the fields, is stored wrapped, and
   the KEK lives in an **external KMS** — so the database provider holds ciphertext and
   wrapped keys but never a key that opens them. Every row records the `kek_id` that wrapped
   it. No plaintext identifier column may exist in this store.
6. **`Test-PRD-P0-06-keyed_lookup_handle`** — Fields that must stay matchable (email, phone)
   carry an **HMAC-SHA256 handle under a secret key**, never a bare digest. Hashing was
   rejected as a protection mechanism: a phone number has ~10^10 possible values and is
   enumerated on a laptop in seconds, and under GDPR Recital 26 a re-identifiable hash is
   still personal data. Exact-match lookup by handle is the only query available against
   encrypted fields.
7. **`Test-PRD-P0-07-crypto_shred`** — Destroying a wrapped data key crypto-shreds that
   customer irreversibly, and the ciphertext and lookup handles are cleared in the same
   operation. Retained ciphertext with no key is retention with extra steps.
8. **`Test-PRD-P0-08-customers_no_identifiers`** — The `customers` store holds profile, fit
   and consent against an opaque id and **no direct identifier**. Most agent tools bind here
   and can read a profile without ever seeing who it is; only clienteling tools bind to
   `identity`.
9. **`Test-PRD-P0-09-data_minimisation`** — Collect the coarsest field that answers the
   question: **birth year, not date of birth**; fit and measurements in their own table so
   they can be dropped or bound independently; purchase history **derived** from `commerce`
   by `customer_id`, never duplicated. Consent is recorded per purpose with a timestamp and a
   source, and an unknown purpose is rejected.
10. **`Test-PRD-P0-10-erasure_is_real`** — Erasing a profile deletes the row and cascades to
    fit data and consent. The erasure request itself is retained as evidence, holds the
    customer id only — never a copy of what was erased — and cannot be deleted.
11. **`Test-PRD-P0-11-erasure_vs_tax_retention`** — Erasure and tax retention are resolved by
    the split, not by a compromise: orders survive a customer erasure **intact and anonymous**.
    The `order` table is asserted to carry `customer_id` and **no** `email`, `phone`, `name` or
    `birth_year` column, so the guarantee cannot rot when somebody adds a column.
12. **`Test-PRD-P0-12-reversible_edits`** — Non-destructive editing comes from an **append-only
    `customer_version` log**, not from immutable storage. Every edit records field, old value,
    new value, actor and timestamp before it is applied; a revert **appends a compensating row**
    pointing at the original rather than overwriting; the log cannot be updated; and it can be
    deleted only under an open erasure request — otherwise old values would outlive the record
    they belong to.

### 3.3 Commerce, orders and the provider boundary

13. **`Test-PRD-P0-13-webhook_idempotency`** — Order ingest is idempotent: a replayed webhook
    for the same `(channel, external_id)` cannot create a second order. The original payload is
    retained so ingest can be replayed after a mapping fix.
14. **`Test-PRD-P0-14-order_line_snapshot`** — The catalog is in Git, so an order line has no
    foreign key to follow. Lines carry `product_handle`, title, SKU and unit-price snapshots and
    stay permanently readable whatever the catalog does later. A line quantity must be positive.
15. **`Test-PRD-P0-15-money_minor_units`** — Money is stored as an **integer minor amount plus an
    explicit currency**, everywhere, in every store. No floats, no implied currency.
16. **`Test-PRD-P0-16-commerce_port`** — All provider interaction passes through a single adapter
    interface (`shared/commerce/port.ts`). No vendor SDK or vendor identifier appears outside an
    adapter; vendor ids live in `external_ref` and nowhere else, and never as a primary key.

    **Direction of authority is the adapter's to declare, not the platform's.** This feature
    originally required catalog and inventory to project *outbound*, with the provider never
    authoritative. ADR-009 reversed that for Square: a till changes stock without asking us, so
    a competing count of ours is silently wrong in the direction that oversells. What survives
    the reversal, and is what this feature now asserts, is that the *boundary* holds — a
    provider swap is a new adapter and a re-key, never a change to our stores.

17. **`Test-PRD-P0-37-mirror_is_ours`** — Provider data is mirrored into stores we own, in our
    own shape, with our uuids as primary keys. The storefront reads the **mirror**, never the
    provider per request, so a provider outage degrades checkout and leaves browsing intact.
    Mirroring is idempotent: replaying a sync changes no row counts and double-counts no stock.
    A withdrawn product is archived, never deleted (ADR-008).

18. **`Test-PRD-P0-48-scheduled_mirror_sync`** — The mirror is kept current by a **scheduled
    handler on the ops Worker**, not by a person remembering. A cron trigger pulls the
    provider's catalog and inventory through the commerce adapter and writes the mirror; the
    handler holds no mapping logic of its own, so what runs on a schedule is exactly what runs
    on a webhook. Every run records its outcome in `mirror_sync` — a failed one included, so
    "the sync has not run since Tuesday" is a query rather than a guess. A service-boundary
    failure is logged as **one ERROR that says plainly which failure it was**: the credential is
    unset, the credential was rejected, or the provider was unreachable. Those are three
    different repairs and a single "sync failed" line distinguishes none of them. The credential
    itself never appears in a log line. A failed run changes nothing: the last good mirror
    stands, and the shop keeps selling what it last knew to be true.

19. **`Test-PRD-P0-38-webhook_authenticity`** — Provider webhooks are verified before their
    contents reach any code that trusts them: signature checked over the notification URL and
    raw body with a constant-time comparison, and an unrecognised event normalised to `null`
    rather than guessed at. An unverified payload is not a slow path, it is refused.

20. **`Test-PRD-P0-39-provider_rate_limits`** — The adapter treats a provider's rate limit as an
    expected condition rather than a failure: 429 is backed off and retried, and a
    service-boundary failure is logged with no credential in the message.
21. **`Test-PRD-P0-17-channel_agnostic_orders`** — A new sales channel — POS included — is a new
    adapter and a new `channel` value, with **no schema change**. Card data is never stored; a
    channel token and last four digits only, so the platform stays out of PCI scope.

22. **`Test-PRD-P0-40-closed_category_set`** — Staff author products by talking to their own AI
    client, and an agent authoring a product chooses a category from the set that **already
    exists** in the provider. The choice is a **suggestion carrying its reasoning**, never a
    silent assignment, and a category id outside the existing set is refused in code — by
    reading the set — rather than discouraged in a prompt. Creating a category is a **separate,
    explicitly gated action** that refuses a near-duplicate and says in its own description that
    it is rarely the right tool.

    The rule exists because the failure is silent and cumulative. An agent that may mint a
    category will mint one whenever the existing name is not the phrase it had in mind, and a
    month of that leaves "Coats", "Outerwear", "Jackets" and "Coats & Jackets" side by side —
    at which point the storefront navigation tells a customer nothing, and no human ever took
    the decision that made it so.

    Authoring is also where the **direction of authority** in P0-16 becomes operational: the
    agent writes to the provider, which the till also writes to, and our mirror follows by sync.
    An agent writing into the mirror directly would make two writers of one copy and they would
    diverge from the provider silently. Media is the exception in the other direction — the
    original is ours in R2 and the provider gets a copy, so losing the provider loses a
    thumbnail and not our photography.

### 3.4 People and scheduling

21. **`Test-PRD-P0-18-no_double_booking`** — An employee cannot hold two overlapping active
    shifts. This is enforced **in the database** — D1 serialises writes to a single writer, so the
    trigger check is race-free where an application read-then-write is not — on insert *and* on
    update. Intervals are half-open, so back-to-back shifts are legal; cancelling a shift frees its
    slot; an inverted time range is rejected.

### 3.5 Finance

22. **`Test-PRD-P0-19-approved_expense_immutable`** — An approved or reimbursed expense is a
    financial record and cannot be edited in place; it is reversed instead. Progressing its state
    (approved → reimbursed) remains legal.
23. **`Test-PRD-P0-20-cross_store_snapshot`** — An expense references an employee by
    `employee_id` **plus an `employee_name` snapshot**, because `people` is a different database.
    The record stays readable when the other store is unavailable or the referenced row has
    changed. Receipts live in their own KV store, never inline.

23b. **`Test-PRD-P0-66-expense_scanner`** — `/expenses/new` photographs a receipt and
    `/expenses/confirm` files it: any signed-in role, no manager gate, because filing your own
    expense is not the gated action here — approving one (`expense.approve`, already T2) is.
    This is also the first thing that actually commits an `expense.submit` proposal into a real
    row: that tool has always validated and described a write (the amount cap, the budget
    currency match) without performing one — this file's own header names `expense.approve` as
    the only tool that mutates the store — and nothing before this confirm flow ever turned a
    proposal into a row for it to approve.

    **OCR prefills, it never files.** Workers AI (`env.AI`, a native Cloudflare binding — no new
    vendor, no new secret) takes a best-effort read of the vendor, date and total off the photo,
    the same way a phone photo becomes a draft product (P0-59) except here the read is text, not
    a stored image. Every field lands on the confirm page as an editable, pre-filled value, never
    an `INSERT` — a misread total is a wrong dollar amount, and this codebase does not let a
    model write money any more than it lets one write a price straight into Square. A field OCR
    could not read is simply blank, asking to be filled in, not an error.

    The receipt photo is kept: stored in its own KV namespace (`RECEIPT_FILES`, resolved by
    `bootstrap-resources.yml` the same way `APPROVALS` and the asset drop site's `ASSET_FILES`
    are) before the row is written, matching the existing finance-skills rule. Not R2 — ADR-013
    dropped this Worker's one R2 bucket, and reopening it for an unrelated feature risked the
    same account-level wall; KV is proven live here already. `RECEIPT_FILES` is its own
    namespace, never shared with `ASSET_FILES`: a financial record and a working document do not
    belong behind the same binding (agent-tool-contract rule 6).

    **Unverified, stated plainly:** the exact Workers AI model id
    (`@cf/llava-hf/llava-1.5-7b-hf`) and its request/response shape could not be confirmed
    against live Cloudflare documentation from this environment — the same
    `developers.cloudflare.com` wall ADR-007's identity section already hit. A wrong model id
    fails the AI call; `scanReceipt()` treats that identically to "OCR unavailable" — the confirm
    form comes back blank rather than the route erroring — so an unverified model choice degrades
    the feature to manual entry rather than breaking it. Confirming the model against a real
    account is a follow-up, not a launch blocker, because nothing here depends on OCR succeeding.

### 3.6 Audit

24. **`Test-PRD-P0-21-append_only_audit`** — Every agent action — actor, on-behalf-of, domain,
    tool, arguments, result, timestamp — is written to an audit store that **no application role
    can update or delete**, enforced by trigger. The domain must be one of the known stores.
    Audit is its own store so it survives a mistake in any other one, and the application holds
    insert-only credentials against it.

### 3.7 Access and authorisation

22. **`Test-PRD-P0-22-access_gated_ops`** — All `ops.vemians.com` **and
    `admin.vemians.com`** access authenticates through **Cloudflare Access with Google Workspace**
    as the identity provider. Swapping provider stays a dashboard change requiring no code change:
    the Worker verifies the Access JWT, which is identical whichever provider issued it. Neither
    application has a login form, a password, a session cookie of its own or a reset path; identity
    is terminated before a request reaches application code. **The two are separate Access
    applications with separate AUD tags**, so a token minted for one is refused by the other.
23. **`Test-PRD-P0-23-group_derived_roles`** — **Admission to `admin.vemians.com` derives from
    the Cloudflare Access policy**, which is edited in the Cloudflare dashboard and nowhere else.
    No admin is assigned inside the app, and removing someone from the policy revokes admin with no
    application-side action. The verified Access identity is the `actor` on every audit row, on both
    surfaces.

    **Scope narrowed by ADR-011.** This originally governed ops as well. Requiring a Google
    Workspace administrator to add a new hire to a group does not survive contact with retail
    staffing, and the workaround for a gate that is too slow is always a shared login — so ops
    admission moved to P0-51. Admin keeps the heavyweight gate precisely because it changes almost
    never and its mistakes are not recoverable from inside the system.
24. **`Test-PRD-P0-24-binding_scoped_tools`** — Tool scope is **structural**: each store is a
    separate Access policy and a separate binding, so a knowledge tool *cannot* read finance. This
    is enforced by binding, not by query filter and not by prompt. `people` and finance views sit
    behind their own policy, tighter than general staff access.

    **The same rule scopes the storefront, and it is an allow-list rather than a ban.** The
    public Worker may bind `catalog_mirror` — products, prices and categories, which are already
    on the page — and **nothing else**. `customers`, `identity`, `commerce`, `people`,
    `finance`, `audit` and `tickets` are bound on the ops Worker and nowhere else, and a check
    names all seven so that adding one to the storefront fails the build rather than passing
    review. The invariant was originally "the storefront carries zero bindings"; that stated the
    mechanism instead of the intent, and the intent is that **the shop cannot reach customer
    data** — which a read-only mirror of public catalog facts does not.
25. **`Test-PRD-P0-25-write_approval_gate`** — Reads execute directly; **writes require explicit
    human approval before execution** — a reviewable pull request for the Git stores, an in-session
    approval for the D1 stores. Rate and monetary caps are enforced in code, never in the prompt.
    Refunds, payroll changes and record deletion are not gated — they are **absent**.

28. **`Test-PRD-P0-50-admin_surface_isolated`** — `admin.vemians.com` is a **separate Worker**
    with its own Access application, its own AUD and its own hostname. The ops Worker holds **no
    binding to the access store** and no code path that reaches it — not a filtered query, not a
    convention, no binding at all. Enforced the way P0-24 is: a check names the binding and fails
    the build if it appears in `ops/wrangler.toml`.
29. **`Test-PRD-P0-51-ops_roster_is_square`** — Who may use ops is **Square's team list**, not a
    roster of ours. A team member who is `INACTIVE` in Square is refused, with no application-side
    action — offboarding happens where hiring happens. Cloudflare Access still proves *who you are*
    at the perimeter; Square decides *whether you work here*; the admin surface owns only the
    **job-title → role map**, a handful of rows and none of them per-person. Ops reaches that map
    over a **service binding** — Worker to Worker, never over the internet, never through Access —
    and **denies when the call fails**. An authorisation service that fails open is worse than
    none, because it is trusted. Decisions are cached in-isolate for a short TTL, so a revocation
    takes effect in seconds rather than at the next deploy.

    **Superseded ADR-011's per-person allow-list** (ADR-012). A second place that records
    employment is a second roster, and two rosters disagree the first week somebody leaves.
30. **`Test-PRD-P0-53-ops_grants_nothing`** — **Ops never offers a capability the person's Square
    job could not already perform by hand.** Not gated behind an approval — **absent from the tool
    list they are handed**, the way P0-25 already treats refunds, payroll and deletion. Ops is a
    delegate: it accelerates Square work and confers no Square rights.

    **This is honoured, not enforced, and the difference is written down rather than discovered.**
    Square's API exposes no permission data — verified against Square's own OpenAPI specification:
    `TeamMember` and `Job` carry none, and no schema in the specification is named for permissions.
    So a job title stands in for a permission set, and a title is not one. Two structural
    mitigations: each role's tool list is chosen to sit **below the plausible floor** of that title,
    with anything uncertain absent rather than gated; and every ops action **writes through Square**,
    so it lands in the history a manager already reads. A delegate that leaves no trace in the
    principal's records is not a delegate.
31. **`Test-PRD-P0-52-no_self_granted_admin`** — **No Worker holds a Cloudflare API token**, and no
    Worker calls the Cloudflare API. The admin surface can therefore edit the ops allow-list and
    **cannot create, modify or delete an Access policy** — admin is granted in the Cloudflare
    dashboard or not at all. An attacker who fully owns the admin Worker gets the ops allow-list
    and still cannot make themselves an admin. Enforced structurally: no `api.cloudflare.com` in
    any Worker source, and no API-token binding or secret in any `wrangler.toml`.

### 3.8 Storefront

26. **`Test-PRD-P0-26-owned_storefront`** — `vemians.com` is ours: Astro on Workers, our design
    tokens and components, no vendor theming layer. It renders products, collections and content
    from the Git catalog and our own R2 media, makes **zero** calls to any commerce provider except
    to mint a checkout URL and to submit the contact form (P0-58, ADR-015 — one file, one scoped
    credential, everything else on the browsing path exactly as pure as before), and keeps our
    handles as stable URLs across a provider switch.
27. **`Test-PRD-P0-49-mirror_or_seed`** — The storefront **prefers the mirror and falls back to
    the seed catalog when the mirror holds no rows**, and logs at INFO which of the two served
    the request. A sync that has never run, or that failed, must leave the shop stocked rather
    than blank — an empty grid reads as a broken shop, and blanking the catalog is a worse
    failure than serving a stale one. The same fallback is what lets `wrangler dev --local`
    serve a real shop with no provider account and no mirror attached. The page says which
    source it is rendering rather than claiming one and serving the other.
28. **`Test-PRD-P0-27-adaptive_grid`** — The catalog grid is **resolution-adaptive with no
    breakpoints**: column count derives from available width (2 columns at 390px through 11 at
    3840px) with card width held between 173px and 323px. `auto-fill`, never `auto-fit` — a
    filtered result must not stretch two cards across a 4K viewport.
29. **`Test-PRD-P0-28-image_contract`** — The design is image-led, so imagery is a contract:
    **8:9 (1:1.125)** product images on the `#EFF0F4` ground, served as AVIF/WebP with `srcset` cut
    to actual grid widths, every image carrying explicit dimensions, under an **image-weight budget
    enforced in CI**. N1 is not otherwise reachable.

### 3.8.1 Storefront interaction and motion

> **Provenance.** §3.8 above is measured. This section is not. The reference is egress-blocked and
> nobody has observed its behaviour, so every value and every gesture here is **genre convention**.
> `shared/design/interaction.css` and `shared/view/enhance.client.js` mark each one INFERRED at the
> rule that implements it. What is *not* inferred is the shape of the guarantees: they hold whether
> or not the specific timings turn out to be right.

36. **`Test-PRD-P0-42-progressive_storefront`** — Every function of the storefront is a plain GET the
    Worker answers in HTML. Filter, sort and page size are the **query string** (`/?brand=…&sort=…&n=…`),
    filtering happens server-side, "show more" is an `<a href>` to that URL, and product imagery is
    `<img src>` with explicit dimensions. JavaScript adds **only** enhancements over that markup and
    supplies none of it. The one control that cannot work without a script — the wishlist — is
    therefore not rendered as a control without one: the server ships an `aria-hidden` glyph and the
    script replaces it with a button, because a dead button is worse than no button. With scripting
    off the page renders in full and every link resolves.
37. **`Test-PRD-P0-43-restrained_motion`** — Motion is a budget, not a feature: **150–250ms,
    transform and opacity only**. No parallax, no bounce, no shadow that appears on scroll, no
    `!important`. Every duration in the storefront resolves from **one pair of custom properties**,
    and `prefers-reduced-motion: reduce` remaps that pair to `0s` — so the computed
    `transition-duration` on every animated element is `0s` and the transition is **removed, not
    shortened**, while every state change still happens, instantly.

    **Sections arrive as you reach them.** This clause used to forbid scroll-triggered reveal
    outright; the shop's owner asked for the opposite — blocks that fade up as you scroll, easing in
    and out, a fluid feel — and how the house moves is theirs to decide. What did **not** move is the
    floor underneath it, and that is what is checked: the hiding rule is gated on **both** a running
    script and an attribute that script has set, the observer guard runs **before** anything is
    hidden (so no observer means nothing is ever hidden), the reveal is 12px of transform and opacity
    so it cannot shift a neighbour, reduced motion removes it, and the observer **never fetches** —
    infinite scroll stays forbidden. Easing may use a curve, and a curve must stay inside the unit
    square: an overshoot is the bounce this design refuses.
38. **`Test-PRD-P0-44-pointer_and_keyboard_parity`** — Hover affordances are gated on `pointer: fine`
    and do **nothing at all** on touch: no node created, no byte fetched, so a tap cannot strand a
    phone in a hover state. Everything a pointer can reach, a keyboard can reach, with a visible focus
    state. The filter and sort surface is a **real modal dialog** — focus-trapped, Escape-closes,
    focus returned to the trigger it came from, background scroll locked — not a dropdown. Paging is a
    single control between the grid and the footer; **infinite scroll is forbidden**, because it puts
    a receding wall between a keyboard user and the end of the page.
39. **`Test-PRD-P0-45-stable_layout`** — The grid never moves. Measured **CLS 0** with images held and
    then released. Every image has explicit dimensions inside the 8:9 `#EFF0F4` slot (§3.8), so an
    undecoded card is indistinguishable from a decoded one; **no element is parked at `opacity: 0`
    waiting on a scroll observer**, and the first still frame is a complete page. Where a script
    changes how something is laid out, the decision is made in `<head>` before first paint rather
    than corrected afterwards. Load-more **appends**, so nothing already on screen can be pushed.
40. **`Test-PRD-P0-46-viewer_local_wishlist`** — The wishlist is per-viewer state in `localStorage`,
    every access wrapped in `try`/`catch`, with **no network call and nowhere on the server to put
    it**: the only binding the storefront carries is the read-only catalog mirror (P0-24). localStorage
    throws — not returns null — with site data blocked, in some private windows and at quota; that
    degrades to an in-memory wishlist, never to a broken page, and is logged at DEBUG because it is a
    benign fallback rather than a failure.

41. **`Test-PRD-P0-56-shop_with_a_door`** — We are a shop with a door before we are a shop with a
    checkout, so the address, the opening hours, how to join the mailing list and how to reach a
    person are **first-class pages**, not footer text. Hours are **structured data** — a weekday
    index and two times, `null` for closed — rendered with consecutive identical days collapsed, so
    "are you open now" is answerable by code rather than by reading a paragraph. The address, phone,
    email and social accounts live in **one module** and every page renders from it: a phone number
    that is right in the footer and wrong on the visit page is worse than one that is missing.

    Directions are **two plain links** to Google Maps — one that opens the place, one that opens
    directions from wherever the visitor is standing — built from the documented query parameters
    with the address encoded. **No embedded map**, no API key on the page: an `<a href>` loads
    nothing, and this Worker makes no outbound request at all (P0-37). The one deliberate
    exception to "no third-party script" is Square's own Appointments booking widget, scoped to
    exactly the `#appointments` section on `/visit` (ADR-014) — everywhere else, the guarantee
    holds as written. **Appointments is shelved** (`SITE.appointments.shelved`, the owner's own
    call): the section is absent from the page entirely rather than shown with a phone-number
    fallback, because a section for something we are actively not offering is worse than no
    section. The wiring underneath is untouched and un-shelving it is a one-line flip.

    **Joining the mailing list is a plain link out**, the same trust level and the same "link,
    don't rebuild" call ADR-009 already made for checkout: Square's own hosted enrolment page
    (Customer Directory → Customer programs), never a form this codebase collects or stores.

    **A contact form ships only when it has somewhere to go.** A form that posts into nothing lets a
    person believe they have been in touch when they have not, so until a destination is chosen the
    page carries the phone number and the email, both of which work. Anything not yet real — the
    address, the booking widget or link — is marked as a placeholder in the source rather than presented as
    fact. The sign-up link is not a placeholder: it is the real, owner-supplied URL.
42. **`Test-PRD-P0-57-two_level_navigation`** — The menu is a **drawer**: it slides in from the
    inline start over a scrim, and a category with sub-categories opens a second pane that arrives
    from the inline end with a back control at its head. **Both levels are derived from the serving
    catalog** exactly as the single level was (P0-47) — a category with no sub-categories is a single
    destination rather than a heading over nothing, which is what a mirror-backed shop gets until
    Square's taxonomy has two levels. A sub-category link names **both** levels, and both are carried
    across filtering and paging, so a filter applied inside Dresses stays inside Dresses.

    **With JavaScript off it is a nested list in normal flow** — the whole taxonomy, every link real,
    nothing hidden — and the trigger is not rendered at all, because a control that cannot work must
    not be on the page. The drawer and the filter panel are **one dialog implementation** used twice:
    written separately, the second copy is always the one that forgets to return focus.
43. **`Test-PRD-P0-58-square_contact_form`** (ADR-015) — The visit page's contact form — full
    name, email and a message required, phone the one optional field — does not write to a store of
    ours. It calls Square's `CreateCustomer` endpoint and the submission lands as a customer record
    in the merchant's own Square Customer Directory, message included in the record's `note` field,
    the same directory the counter iPad already writes to. **This is the storefront's second
    deliberate exception** to "no calls to a commerce provider" (P0-26/P0-37; the first is minting a
    checkout URL) and **the first secret the public, unauthenticated storefront Worker has ever
    held** — scoped to exactly one file (`store/src/contact.js`) and one credential name
    (`SQUARE_ACCESS_TOKEN_CONTACT`, never the name ops's catalog sync uses), so a compromise of the
    public surface cannot widen into whatever that other token can do.

    Every failure is answered honestly, never a quiet success: an unreadable form, a missing
    required field or a malformed email is refused before Square is ever called; a Square failure or
    a missing credential returns a plain sentence and a working fallback (the phone number, the
    email), never a 500 or a page claiming the message arrived when it did not. A GET on `/contact`
    reads as 404, not 405 — the same route must not confirm its own existence to a method probe. A
    honeypot field is answered with the same success page a real sender gets and is never sent to
    Square, and the token itself never appears in a log line, matching the rule `client.js` already
    holds for every other Square credential in this codebase.

### 3.9 Provider independence and traceability

29. **`Test-PRD-P0-29-exit_test`** — Provider independence is a **CI check** (§7), not a claim.
    Deleting a provider must leave catalog, orders, schedule and finance intact, remove every
    vendor identifier, and leave the storefront building and rendering. A failing Exit Test blocks
    merge.

    **Media is excluded, deliberately (ADR-013).** With no R2 bucket bound, Square holds the only
    copy of a photograph and the exit is an export taken *before* the account closes. This clause
    used to say media survived provider deletion; that stopped being true when the bucket was
    dropped, and a requirement that quietly reads as satisfied is worse than one that admits its
    scope. Binding `MEDIA` restores it with no code change.
29a. **`Test-PRD-P0-55-square_held_media`** — Where no bucket is bound, photographs are uploaded
    **directly to Square** and Square holds the only copy. The key is minted before the bytes
    arrive, so the mapping from our key to Square's image id is carried by Square's own searchable
    `CatalogImage.name` rather than by a table here: the store is the index.

    The two stores present **one surface** and `mediaStoreFor(env)` chooses between them, with the
    signed upload link minted by a single shared function — the browser that posts the bytes and the
    agent that minted the ticket must reach the same store, and two implementations that re-derive
    a route or a date format do not stay in agreement. Originals are never overwritten on either
    path. `bytes()` on the Square path **refuses by name** rather than returning empty, so a caller
    cannot read "we hold no pixels" as "there is no image".

29b. **`Test-PRD-P0-59-one_click_photo`** — Adding a photo does not require an assistant.
    `/media/new` on the front page mints one signed upload ticket and sends the browser straight
    to the picker `catalog.upload_image` already uses — same key shape, same signature, same
    `MEDIA_SIGNING_KEY`, one shared path rather than a second one to keep in agreement. Each click
    is its own ticket for its own R2 key: two clicks are never the same slot, and a slot is never
    reused for a second photo. No Access role, or no `MEDIA_SIGNING_KEY` configured, refuses with a
    plain page rather than a link that would 403 or 503 further down.

29c. **`Test-PRD-P0-60-spreadsheet_products`** — `/products/batch` and `/customers/batch` each turn
    one CSV into one T2 approval per row that resolves cleanly — `catalog.create_product` for the
    first, `customer.create` (P0-61) for the second — the exact same tool, the exact same checks a
    chat-drafted call goes through, re-derived nowhere. `batch.js` holds the two column-to-`args`
    mappings; parking an approval is the one shared step underneath both. One record per row: a
    spreadsheet cell cannot describe a product with several sizes at several prices, or a customer
    with two phone numbers, without a schema of its own, so anything needing that still goes
    through the chat tools. Photos are out of scope for products for the same reason a cell cannot
    hold image bytes — added afterward, per product, the same way a one-off product's photo is
    (P0-59).

    A row that cannot even be attempted — a product with no title, a category that is not exactly
    one of the closed set's names, a price that is not a plain decimal — is reported with the
    reason and never reaches `runTool`, because the tool layer has no way to say "that is not a
    number"; a customer row's own refusals (no identifying field, a malformed email) come straight
    from `customer.create`'s own check(), relayed rather than re-derived. A file over
    `CAPS.BATCH_MAX_ROWS` is refused whole, before any row is touched, rather than silently
    truncated. Uploading a spreadsheet mints approvals; it does not consume any of them — each one
    is still opened and said yes to individually, on the same `/approvals/` page a single record's
    draft produces, so there is one confirmation screen in this codebase, not two. Both routes are
    manager+ only, at the route itself: either tool's own `minRole` would otherwise turn a staff
    upload into the same refusal repeated once per row.

29c'. **`Test-PRD-P0-70-flexible_spreadsheet_columns`** — A real spreadsheet is not typed to our
    sample file. `pick()` (`ops/src/batch.js`) now normalizes both the uploaded header and the
    synonym list to letters-and-digits only before comparing, so "Item Name", "item_name" and
    "ITEM-NAME:" all match the same column — punctuation, casing and an underscore are not a
    different column, the same rule `csvRecords()` already applied to whitespace. The synonym
    lists themselves are also wider (`item`, `style`, `product type`, `retail price`, and
    others), covering headers a real export is likely to use rather than only the ones this
    codebase's own sample file happens to name. **This still refuses, honestly, past that
    point**: a column this codebase has never heard of (a completely different word, not a
    formatting variant) is still an unmatched title and a plain "no title column" skip — the
    fix is broader matching, not a guess at an unfamiliar word. For a spreadsheet shaped
    differently enough that no synonym list will ever cover it, the ops assistant chat (any
    role, one click from the front page — P0-69) already has full `catalog.*` tool access and
    can be handed the same rows as plain text to interpret with actual judgement, which no
    fixed column list can do.

29d. **`Test-PRD-P0-61-square_customer_intake`** — `customer.create` writes a new customer into
    SQUARE's own Customer Directory — the same directory the till and the storefront's contact form
    (P0-58/ADR-015) already write to — using Square's own field names (`given_name`, `family_name`,
    `email_address`, `phone_number`, `note`, `reference_id`) rather than inventing our own. **This is
    not P0-33.** The `customer.*` family above it (`profile`, `fit`, `history`, `update_fit`) reads
    and writes OUR OWN `customers` store, keyed by an opaque `customer_id`, and P0-08 promises that
    family never returns a name, email or phone number; `customer.create` holds no `customers` or
    `identity` binding at all; a Square customer id is not a `customer_id` any tool in that family
    will ever accept. P0-33's encrypted vault with per-purpose consent remains unbuilt and deliberately
    deferred (identity-skills: build it last) — this is the smaller thing ADR-015 already established
    is fine, leaning on Square's own directory rather than building a second place to hold the same
    kind of data. Square's own rule is enforced before Square ever sees the call: at least one of
    `given_name`, `family_name`, `email_address` or `phone_number`. Minimum role manager, same T2 gate
    as every other write in this codebase.

30. **`Test-PRD-P0-30-prd_traceability`** — Every check in a PRD-backed test file carries a
    `Test-PRD-*` label, and every label used must exist in this PRD. The test files enforce this
    themselves, so a renamed or invented label fails the run rather than drifting silently.

---

### 3.10 Inventory and tickets

30. **`Test-PRD-P0-31-inventory_ledger`** — Stock is a **ledger, not a number**. No tool writes
    `on_hand`; every change is an append-only `inventory_adjustment` with a delta, a reason, an
    actor and an optional `reverses` pointer, and a trigger folds it into the count. Direct
    writes to `on_hand` are refused by the database. History cannot be edited or deleted, so the
    undo for a mistake is a reversing adjustment that leaves both the error and the correction on
    the record.

31. **`Test-PRD-P0-32-tickets`** — Company-wide issues live in their own `tickets` store. A ticket
    cannot be deleted, only moved through status, and resolving one requires a timestamp.
    Comments are append-only. Links to orders, customers, products and shifts are id plus a
    non-identifying label, never a foreign key, so a ticket survives the erasure of what it
    points at and reading a ticket does not confer access to the linked record.

31b. **`Test-PRD-P0-65-asset_drop_site`** — Staff drop a working document (a vendor price list, a
    policy note, meeting notes) at `/assets/new` — a plain browser upload, no assistant needed,
    same shape as `/media/new` — and any role can then have their own agent read it back through
    `assets.list` / `assets.read`. Its own store (`shared/db/assets.sql`), on the same blast-radius
    rule as `tickets`: a dropped file is not customer data, not commerce, not people, and belongs
    nowhere else. The original bytes live in R2 (`ASSET_FILES`), reachable only from the upload and
    download routes in `src/index.js` — `assets.list` and `assets.read` declare no resource at all,
    so the tool layer holds no binding that could return raw bytes to a model even by mistake
    (P0-24). Text is extracted once, at upload, for the formats with no ambiguity about what "text"
    means — `.txt`, `.md`, `.csv`, `.json` — and stored in the index; a PDF, a spreadsheet workbook
    or a Word document is accepted and listed like everything else, but `assets.read` returns `text:
    null` and a plain note rather than guessing at content it never parsed. Extending extraction to
    those formats needs an edge-runtime-compatible parser this codebase has not vetted, and is a
    deliberate follow-up, not an oversight. Extracted text is capped in characters
    (`CAPS.ASSET_TEXT_MAX_CHARS`) and marked `truncated` past it — a limit an agent is told about,
    not one it silently loses content to. The index row is append-only at the database (no
    `UPDATE`, no `DELETE`): a newer version of a document is a new row, never an edit to an old one.

32. **`Test-PRD-P0-33-customer_intake`** — Creating a customer writes the profile and the
    encrypted identity as one operation, records consent per purpose at intake, and is a T2
    action for manager and above. A customer is never created as a side effect of another tool.

33. **`Test-PRD-P0-34-multi_client_tools`** — The tool layer has more than one consumer: the
    browser chat, a remote **MCP endpoint** at `ops.vemians.com/mcp`, and any future automation.
    Tools are defined once and every consumer goes through the same `runTool`, so tiers, role
    filtering, caps and the audit row cannot differ per client. A tool a role may not use is
    absent from that client's tool list rather than present and refused.

34. **`Test-PRD-P0-54-skill_discovery`** — A connecting agent is served the **skills**, not just
    the tool names. Tool descriptions say what a tool is called; the skills say that the category
    set is closed, that price and publish are two gates rather than one, and that a photograph goes
    through an upload ticket — the knowledge a coworker's own Claude or ChatGPT needs to use this
    correctly on its first attempt rather than by being refused into it.

    Each `skills/<name>/SKILL.md` is **bundled as a text module**, so the bytes an agent reads are
    the bytes in the repository at deploy time: there is no second copy to drift. They are exposed
    **both** as MCP resources (`skill://<name>`) and as the `skills.list` / `skills.read` tools,
    because resource support across MCP clients is uneven while tool support is universal — and the
    point of this endpoint is that we do not control which client connects. The server's
    `instructions` name the skills first, so an agent reads before it writes.

    Skills are **filtered by role exactly as tools are**, by asking the tool registry rather than by
    a second table of domains — a skill is listed only when the role can call at least one tool in
    that domain. An out-of-role skill reads as **absent, not forbidden**: a distinguishable refusal
    would leak which documents exist for other roles.

    **The front page is part of the discovery surface.** `ops.vemians.com/` is what a new coworker
    is sent, and what someone pastes into an assistant, so it carries both audiences in one
    document. **One thing is open at rest** — the address to paste into an assistant, and the
    first few things to say to it — because that is what nearly everyone is there to do, once. The
    `claude mcp add` invocation is not that: it is a terminal command for the few people who have
    one, and it lives in the developer fold, because a person told to paste a shell line into a chat
    window is being asked to debug our vocabulary before they can start. The
    roster, the tier rules, the troubleshooting, the machine-readable contract and the seed data are
    **closed accordion rows in small print**, ordered by how many people will ever open them. The
    whole page fits a phone screen without scrolling. Folding costs the machine reader nothing: a
    `<details>` is in the DOM whether or not a person opened it, so an assistant that fetches the
    URL still gets the endpoint, the skill names readable at that role, the tier rules and the
    tools bound to it. **The visible half is written for a shopkeeper, not an engineer** — no tier
    numbers, no product names, no vocabulary of ours a reader would have to learn before they can
    start; a labeled check reads the prose and fails on the words we keep reaching for. Everything
    technical sits inside the folded block, which is the one part written for a machine.

    **`/whoami` answers a person too.** It is where someone is sent when their role reads none, so a
    browser gets a page naming the usual cause — a sign-in the browser minted before they were added
    — with a link to sign out and the whole answer in one copyable block to forward. Any client that
    does not ask for HTML, and `?format=json`, still get exactly the JSON they got before: the
    diagnostic that made the role bug findable is not taken away to make room for the page.

    The endpoint is **derived from the request host**, never typed, so a preview
    deployment cannot hand a visitor a command pointing at production. The tool counts shown come
    from the same registry that filters the calls, so the page cannot advertise a capability the
    tool layer would refuse. Checked by `ops/test/ops-page.test.mjs`, which fetches the real page
    from the real Worker rather than asserting over the template.

34a. **`Test-PRD-P0-62-onboarding_greeting`** — The MCP server's own `instructions` — the one
    thing every connecting agent reads before its first reply, regardless of which chat client it
    is — tell it to greet the coworker by name and offer a short numbered menu of what it can help
    with right now, then wait, rather than opening with an explanation of tiers or tools. The menu
    is a specific, pinned set of four choices, in this order: **Add Merchandise, Add Customers,
    Submit Expenses, More Options** — a request for exact wording, not a suggestion, so the
    regression test asserts the four strings appear in that order rather than loosely matching
    "there is a menu." Once they pick Merchandise or Customers, a second short multiple-choice
    question asks spreadsheet-or-narrate before anything else happens. Both answers reach the same
    place: point at `/products/batch` or `/customers/batch` for a spreadsheet; for a narrated
    list, draft and create one item at a time exactly as for a single one — there is no separate
    "batch" tool — then present every resulting approval link together at the end. Submit Expenses
    is different on purpose: no second question, no tool call, straight to `/expenses/new`
    (P0-66) — there is nothing to draft. "More Options" has no fixed submenu; the agent says
    plainly what else it can do for this role rather than inventing a second rigid menu. The text
    also says the approval link is a real form to send them to, not something to walk through in
    chat (P0-63). `buildInstructions(identity)` is a pure function precisely so a test can assert
    on the words a client actually receives, the same lesson the `/approvals/` 404 already taught
    this codebase once (P0-35): reading the code and believing it says the right thing is not the
    same as checking what it sends.

34a'. **`Test-PRD-P0-67-greet_by_first_name`** — The greeting uses the coworker's ACTUAL first
    name, not one the model guesses from an email address. `firstNameFrom(claims, email)`
    (`ops/src/access.js`) tries `given_name` first (the OIDC claim Google Workspace sign-in
    typically carries), then the first token of a full `name` claim, then derives one from the
    email's local part (`ana.garcia@` → `Ana`) — never throwing, never returning empty, because
    "there" beats a crash when nothing at all is available. Whether Cloudflare Access actually
    forwards `given_name` on a real assertion is unconfirmed against a live tenant — the same
    unresolved claim-shape question ADR-007 already raised for `groups` — which is exactly why
    every plausible source is tried rather than assuming one specific field is present.

    Surfaced in **two** places, for the P0-64 reason: `buildInstructions()`'s connect-time
    `instructions` field names it directly ("greet them BY THEIR ACTUAL FIRST NAME — Ana, given
    above") for the client that reliably shows that field (Claude Code); `skills_list`'s own
    tool response now also carries `you: { email, first_name, role }`, because that is the first
    real tool call every onboarding script already tells a connecting agent to make, and a tool
    result reaches the model on every client, `instructions` or not. Both read from the same
    `firstNameFrom()`, so there is one answer, not two that can disagree.

34a''. **`Test-PRD-P0-68-one_click_ops_chat`** — Connecting a third-party assistant (Claude,
    ChatGPT) is a real, deliberate option, but it is not the ONE-CLICK path: it needs the person
    to leave `ops.vemians.com`, open their own client's connector settings, paste a URL, and
    complete a separate sign-in. The built-in browser chat already on the ops front page (`/agent`,
    `agent.js`) is the one-click path — a coworker is already signed in to see the page at all,
    so asking a question there is the whole interaction. It existed all session with its own
    bare system prompt and none of the greeting-and-menu work — a person using it got a plain
    Q&A assistant while the "real" experience lived only in the MCP path nobody reaches without
    leaving the page first.

    `greetingScript(firstName)` (`ops/src/greeting.js`) is the fix: the FIRST MESSAGE / SECOND
    MESSAGE / "Submit Expenses is different" / "that link is a real form" protocol, extracted
    into its own dependency-free module and shared VERBATIM by `buildInstructions()` (MCP) and
    `agent.js`'s `systemPrompt()` (the built-in chat) — one text, not two prompts describing the
    same four choices in almost the same words until one of them drifts. `systemPrompt()` also
    now resolves the person's real first name the same way (`firstNameFrom`), so the one-click
    chat opens exactly like the MCP path: "Hi Ana — 1) Add Merchandise 2) Add Customers
    3) Submit Expenses 4) More Options."

    **This surface has a real dependency the others do not.** `/agent` calls the Anthropic
    Messages API directly and needs `ANTHROPIC_API_KEY` set as a Worker secret; with it unset,
    `agentTurn()` degrades to an echo stub rather than erroring, which is correct behaviour for a
    prototype with no key configured but means "one click, stupid simple" is only actually true
    once that secret exists on this deployment — unconfirmed from this environment, the same as
    every other secret-gated behaviour in this codebase.

34a'''. **`Test-PRD-P0-69-one_click_welcome_menu`** — Immediately after the identity line, a
    literal welcome message by first name leads into four clickable choices — **Add Merchandise,
    Add Customers, Submit Expenses, More Options** — the same four words as the chat greeting
    (P0-62/P0-68), but as real page buttons rather than a conversation someone has to start. (P0-74
    now puts the built-in assistant between the greeting and this menu — see that entry for why;
    the menu itself, and its four choices in this order, are unchanged.) The first three were
    ORIGINALLY direct links to routes that already did the whole job with no assistant at all
    (`/products/batch`, `/customers/batch`, `/expenses/new`); "More Options" was an in-page anchor
    to everything else. **Superseded by P0-83**, which routes all three through chat instead.

    **This supersedes P0-54's earlier framing.** The front page used to have "one job for almost
    everyone: hand over the address to paste into their own assistant" — true when the only way
    to use this surface was to leave it for someone else's client. It is no longer true: the
    one-click menu is the primary path and sits above even that address, and the built-in chat
    (P0-68) that used to live captioned "your own assistant is the one worth using" inside a
    closed accordion is now open at rest, right where "More Options" points, because steering
    people away from the one surface that needs no setup at all was the opposite of "stupid
    simple." Connecting a third-party assistant is still there, still real, just demoted to what
    it actually is now: an option for someone who prefers their own client or wants to hand it a
    photo from their own device, not the thing everyone is assumed to want.

34b. **`Test-PRD-P0-63-editable_approval`** — The `/approvals/` page is a real, editable form for
    the two tools the spreadsheet and narrated-list flows actually produce
    (`catalog.create_product`, `customer.create`): a coworker can fix a typo'd title or a wrong
    price right there before saying yes, not only accept or reject exactly what was proposed. Every
    other T2 tool keeps the plain read-only view — building a correct generic editor for an
    arbitrary schema is a different, larger project, and a wrong guess at one is worse than the
    honest raw view. An edit still goes through the tool's own `check()`: one that will not parse
    (a price that is not a plain number) is refused before Square ever sees it, exactly like a bad
    CSV row, and the link survives to be tried again rather than being burned on a failed attempt.

    **The regressions this exists for — two of them, stacked in the same handler:** the POST
    handler referenced `email` without ever declaring it in scope, so every real browser submission
    of "Yes, do this" for an MCP-parked approval threw `ReferenceError: email is not defined` rather
    than running anything. Once that was fixed, the same handler still built the approver it passes
    to `approvePending()` as `{ email, role }` — never `verified` — so `approvePending()`'s own "no
    unverified assertion" guard refused every submission unconditionally, including one carrying a
    genuinely signed, JWKS-verified Cloudflare Access token. Neither bug was caught earlier because
    every prior test of this path called `approvePending()` directly from a test file, never through
    the actual Worker route a browser hits, and neither bug alone was sufficient to notice the
    other — the real approval flow had, in effect, never executed a write end-to-end until both were
    found and fixed together. `ops/test/catalog-write.test.mjs`'s P0-63 checks now drive
    `worker.fetch()` against `/approvals/<id>` for real, POST included, with a genuinely RS256-signed
    and JWKS-verified assertion — the same lesson P0-35's own history already taught this file once
    about a link nobody actually followed.

34c. **`Test-PRD-P0-64-greeting_survives_every_client`** — The greeting-and-menu opening (P0-62)
    is stated twice, in two different places, on purpose. `buildInstructions()`'s connect-time
    `instructions` field is the version Claude Code's own CLI actually shows the model before its
    first reply; the `agent-tool-contract` skill's new "First message to a person" section is the
    version every other client sees, because it arrives as the result of a real `skills_read` call
    rather than a field a client is free to drop. **The regression this exists for:** a coworker
    said "hello" in a fresh session and got the generic assistant identity line, not the menu —
    because the client they were using does not surface server `instructions` at all (confirmed for
    at least the ChatGPT and Claude.ai web connectors). Relying on `instructions` alone made the
    entire onboarding promise true for one client and silently false for the two the ops page's own
    visible instructions point most people at ("paste this into your Claude or ChatGPT"). Every
    role reads `agent-tool-contract` first (P0-54), so the fix is not a new mechanism — it is
    putting the same words somewhere every client is already guaranteed to read. The `.mcp.json`
    checked into the repo root additionally lets a Claude Code session opened in a clone of this
    repository connect after one manual, one-time approval instead of the `claude mcp add` line;
    a remote or headless Claude Code session still cannot complete the interactive Access sign-in
    on its own, and the ops page's developer section says so rather than implying otherwise.

34d. **Prompt-based editing on the approval page — deferred, not built.** The click-to-edit fields
    of P0-63 are the click-and-type half of "review, edit manually, or use prompts"; the third
    option, telling the page in plain language what to change and having it edit the fields for
    you, is deliberately not part of this change. It needs a new server-side LLM call from the ops
    Worker itself — a new API key/secret, an ongoing per-call cost, and a new prompt-injection
    surface sitting directly on a page whose submit button triggers a real write to Square — and is
    a separate decision from the editable form it would sit on top of, same as P0-33's encrypted
    vault is a separate decision from the Square customer intake it would sit next to. No tool, no
    route and no field for it exists yet; when it is built it still goes through the same
    `applyFormEdits` → tool `check()` path P0-63 already established, so a prompt can suggest a
    field value but never bypass validation.

35. **`Test-PRD-P0-35-approval_never_in_band`** — A T2 action requested through MCP does not
    execute in the model's context. It returns an approval URL on `ops.vemians.com`; the token is
    minted server-side from the human's browser action and is never returned to, nor accepted
    from, a model. This holds identically for every client.

36. **`Test-PRD-P0-36-working_set_index`** — Every store exposes an **index** — the working set
    — and that is what a read returns by default. Rolling data off the index sets an
    `archived_at` marker; **nothing is deleted**, and archived rows stay queryable by an explicit
    call. Only settled data may be rolled off: an open ticket or a future shift is refused.
    The rule exists because an agentic surface pays for every row it reads, in context and in
    latency, so an unbounded default read is a cost, not just untidiness.

41. **`Test-PRD-P0-41-unconfigured_fails_closed`** — A surface that cannot verify an Access
    assertion serves nothing. Unverified assertions are a localhost convenience only: off
    localhost, a Worker with `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` unset refuses every request with
    503 and logs why. The staff Worker also has no `workers.dev` URL, so it is reachable only
    through the hostname Access sits in front of. An unreachable ops surface is a nuisance; a
    reachable one is an incident.

47. **`Test-PRD-P0-47-category_navigation`** — The category nav is **derived from the catalog**,
    not hand-written: every link resolves to a category that holds products, and a new category
    appears without anyone editing a template. Selecting one filters the grid server-side via
    `?category=`, so it works with JavaScript off and is linkable and bookmarkable. An unknown
    or stale category is **dropped rather than filtered on**, so a bad link shows the whole
    catalog rather than an empty grid — which reads as a broken shop, not a bad link. The
    current category carries `aria-current="page"`.

47a. **`Test-PRD-P0-71-product_channel`** — Not every product Square knows about is for the public
    website. `mirror_product` (`shared/commerce/square/schema.sql`) carries a `channel` column —
    `in_store` (the shop only, not shown at any storefront URL), `website` (in the grid and has
    its own page), or `direct_link` (has its own page, left out of the grid, for someone with the
    link). **Fail closed, the same way every other permission in this codebase defaults**: a new
    or freshly-synced product is `in_store` until a person says otherwise, so nothing reaches the
    public site by an omission rather than a decision. This is deliberately **ours, not Square's**
    — Square has no notion of our storefront at all — so `catalog.set_channel` (T2, manager+,
    `ops/src/tools/catalog-write.js`) writes `mirror_product` directly and calls Square for
    nothing; `syncCatalog` (`shared/commerce/square/mirror.js`) never names this column in its
    `UPDATE`, on purpose, so a value set here survives every future sync untouched — exactly the
    guarantee `handle` already relies on. `store/src/catalog.js`'s grid query filters
    `channel = 'website'`; a product's own page (P0-72) accepts `website` and `direct_link` alike
    and refuses `in_store` in the query's own `WHERE` clause, not by a check the caller could
    forget to make.

47b. **`Test-PRD-P0-72-product_detail_page`** — Every product has its own page at
    `/products/<handle>` — the answer to "how do I see product details", asked directly, of a
    shop whose cards used to be `<article>`s with no click-through at all. `loadProduct(env,
    handle)` (`store/src/catalog.js`) is a second, dedicated read alongside the grid's — a
    `direct_link` product must resolve here while never once appearing in the grid's own query,
    which only a separate statement can guarantee. It falls back to the seed catalog under the
    same "mirror not synced yet" case `loadCatalog` already treats as seed-served (P0-49), so a
    fresh `wrangler dev --local` can open a seeded product's page with no Square account; a handle
    that is simply wrong, or that names a real `in_store` product, is an honest 404 either way.
    The grid's card (`store/src/views.js`) now wraps its image and name in a link to that page —
    the wishlist heart stays a sibling control outside it, so tapping the glyph never also
    navigates. **This is not a cart or a checkout** (see Non-goals): the page states the price and
    description and points to `/visit` to see the piece in person or ask about it, honestly,
    rather than rendering a "Buy" button that does nothing.

47c. **`Test-PRD-P0-73-real_photography`** — The storefront now CAN render a genuine photograph,
    not only the placeholder tone-shift SVG. `shared/commerce/square/schema.sql`'s `mirror_image`
    already carried the column for this — `media_key`, "our R2 key, once mirrored" — and
    `ops/src/media-backfill.js` is the fetch-and-store job that column was always waiting
    on: for every synced image with a `source_url` and no `media_key`, fetch the bytes off
    Square's CDN once and `.put()` them into OUR OWN bucket under OUR OWN key, then record it.
    `syncCatalog`'s own `INSERT`/`UPDATE` for `mirror_image` never names `media_key` — the same
    "a column this job doesn't touch survives every re-sync" guarantee `channel` (P0-71) and
    `handle` already rely on. The job runs once per scheduled sync
    (Test-PRD-P0-48-scheduled_mirror_sync), capped at `CAPS.MEDIA_BACKFILL_MAX_PER_RUN` per run so
    a first-time backfill of an existing catalog spreads across several runs rather than spending
    one cron's whole budget; a single photograph's failed fetch is reported and retried on the
    next run, never allowed to abort the rest of the batch.

    **This reverses the one part of ADR-013 that needed reversing.** That ADR's own text predicted
    exactly this: "binding a bucket later restores the original behaviour with no code change" —
    `mediaStoreFor(env)` already picked R2 the instant `MEDIA` is bound, before this feature
    existed. `.github/workflows/bootstrap-media.yml` creates the bucket and gives it a public
    custom domain (`media.vemians.com`), kept as a SEPARATE workflow from bootstrap-resources.yml
    on purpose — an R2 permission failure must not take the KV namespaces down with it a third
    time, which is the exact failure ADR-013 itself records happening twice.

    `store/src/catalog.js` builds the real `<img src>` straight from `media_key` at that public
    domain — a subdomain of vemians.com, so Test-PRD-P0-28-image_contract's "no image loaded from
    anybody else" still holds, and the storefront still makes no fetch of its own and binds
    nothing but `CATALOG_MIRROR`: this is string concatenation over a fact already in the mirror
    row, not a network call. A product with no synced photograph yet still gets the placeholder,
    exactly as before. `store/src/views.js`'s `shotUrl` will not pair a real primary photograph
    with a FABRICATED placeholder hover-alt (a photograph that turns into a cartoon rectangle on
    hover reads as a bug) — a real primary with no second real photo simply has no hover swap;
    only a fully-placeholder product keeps the placeholder swap on both shots, unchanged from
    before this feature.

34a''''. **`Test-PRD-P0-74-chat_first`** — The owner's own direction, asked for directly: the
    built-in ops assistant leads the page. The greeting still comes first — it names who is
    signed in before anything asks for input — but the "Ask the ops assistant" section
    (`ops/src/views.js`'s `opsPage()`) now renders between the greeting and P0-69's one-click
    menu, not after it and not behind "More Options". **This narrows P0-69's own framing without
    reversing it**: the three direct-link buttons are still real, still one click, still on the
    page with no assistant required — they simply no longer claim to be the first thing offered,
    because the person who asked for this explicitly wanted the assistant to be. Nothing about
    the chat itself changed — same open-at-rest box, same tier-2 approval gate underneath it —
    only where it sits.

34a'''''. **`Test-PRD-P0-75-ops_dark_theme`** — The employee area gets its own dark palette —
    near-black ground, warm off-white ink, one clay-orange accent for anything a person actually
    presses — asked for as "the anthropic black theme". **This is an interpretation, not a brand
    asset**: nobody supplied this codebase an official colour file, so the three values
    (`ops/src/views.js`'s `OPS_DARK_CSS`) are a reasonable reading of the ask, named as such in
    the comment beside them, the same honesty this codebase already applies to an inferred
    interaction-design choice (`shared/view/enhance.client.js`'s own INFERRED markers) or an
    unresolved contact detail (`shared/site.js`'s PLACEHOLDER markers).

    **Scoped to `ops.vemians.com` alone, structurally.** The override lives in a SECOND `:root`
    block inside the ops Worker's own stylesheet — prepended to both `OPS_CSS` (the front page
    and `/whoami`) and `APPROVAL_CSS` (every other ops page: approvals, batch upload, asset
    drop, the expense scanner) — and never touches `shared/design/theme.css`, which the
    storefront also loads. A later declaration of a variable theme.css already named simply wins
    the cascade in the same `<style>` tag; nothing here could leak into the shop's own warm-cream
    palette (P0-26/P0-56) without a second `:root` block appearing in a file the storefront
    actually imports, which none of this touches. Every hardcoded `#666` this file used for
    secondary text — seven of them, none of it ever having gone through a variable — became
    `var(--muted)`, a token theme.css never had, for the same reason: a colour tuned to sit quietly
    on cream reads as barely-visible on near-black.

34a''''''. **`Test-PRD-P0-76-valid_tool_schema`** — Found the first time a real
    `ANTHROPIC_API_KEY` reached a real request: every call to the built-in chat answered "The
    model service returned 400." `toolDefinitions()` (`ops/src/agent.js`) was handing Claude's
    Messages API `tool.schema` UNCONVERTED as `input_schema` — this codebase's own validation DSL
    (`tools/validate.js`: a flat `{field: {type, required, format, of}}` map, `required` living on
    each field rather than a top-level array) rather than the JSON Schema object
    (`{type:"object", properties:{...}, required:[...]}`) the API actually requires. The DSL
    validated correctly against runTool()'s own `validate()` — a completely separate code path —
    which is exactly why nothing caught this: every existing test exercised that path or a stubbed
    Anthropic response, and none of them called the real API with a real schema. `toJsonSchema()`
    now converts every tool's schema, recursively for a nested array-of-objects field (`variations`
    on `catalog.create_product`, the one shape that most needed it), before it ever reaches Claude.

34a'''''''. **`Test-PRD-P0-77-chat_attachments`** — A row of two icons under the chat input — a
    photo, and any other file — asked for directly: "let the agent figure out what to do with
    them" rather than the purpose-built, no-assistant paths P0-59/P0-65 already give a photo or a
    document. Choosing either uploads through the SAME stores those paths already use —
    `ops/src/index.js`'s `ingestAgentAttachment` puts a photo in the media store
    (`catalog.upload_image`'s own store) and everything else in the asset store (`/assets/new`'s
    own store) — **before the agent ever sees it**, for the same reason `catalog.upload_image`
    never takes bytes as a tool argument: a model cannot usefully re-emit a photo's bytes into a
    tool call, only reference a key it is already given.

    A photo therefore reaches Claude TWICE, for two different reasons (`agent.js`'s
    `buildUserContent`): as a real `image` content block, so the model can actually look at it and
    reason about what it is showing, capped at `CAPS.AGENT_VISION_MAX_BYTES` — past that the photo
    is still stored in full, just not previewed to the model, which is told so in plain words
    rather than silently seeing nothing — and as a sentence naming the key it is already stored
    under, so a tool call that wants to use it (`catalog.create_product`'s `images`) references
    that key directly instead of the model inventing one or calling `catalog.upload_image` a
    second, redundant time. A non-photo file has no vision block at all — it is EXTRACTED TEXT,
    read the same way `/assets/<id>` already reads one back for a person browsing without an
    assistant, folded into the same sentence. Neither text nor a file is required on its own: a
    photo with nothing typed is still a complete, valid message — "figure out what to do with it"
    being the entire point of handing it to the agent instead of a form.

34a''''''''. **`Test-PRD-P0-78-chat_widget`** — The owner's own words: "ugly still... I want a
    legit chat widget scrolling, similar to telegram... compact vertically." `.log`
    (`ops/src/views.js`'s `OPS_DARK_CSS`) is now a fixed-height, scrolling column of message
    bubbles rather than an ever-growing flat list of paragraphs pushing the rest of the page down
    — MINE align right in the one accent colour on the page; the agent's align left, quiet and
    bordered; a tool step is neither conversational bubble, it is a centred system aside (the
    genre's own "so-and-so joined" convention), never competing with either side of the actual
    conversation. Collapses to nothing at rest (`.log:empty`) rather than showing an empty grey
    box before the first message. The whole assistant now sits inside one visibly bordered card
    (`.chat-top`) rather than reading as loose page furniture. The three one-click task buttons —
    the "big ass text buttons" objected to directly — shrank from bold, filled, accent CTAs to
    small outlined chips: this page has exactly one thing asking to be pressed hardest now, and
    P0-74 already put that thing above these chips, not beside them as an equal.

34a'''''''''. **`Test-PRD-P0-79-quick_actions_over_connect_prompt`** — The owner's own direction,
    read back verbatim: "remove [the connect-your-own-assistant block]... you already have quick
    actions under the chat, that's what I want to expand." The promotional block P0-69 had put where
    "More Options" pointed — the `/mcp` address, "paste this into it to get started," and three
    example prompts to say next — is gone from the page entirely, not merely re-folded: a coworker's
    own path to the shop is the built-in chat and the one-click chips (P0-68/P0-69/P0-74), not a
    second client they have to go set up. "More Options" now anchors straight to the existing
    reference accordion (`ops/src/views.js`'s `.acc` — Who has what, How this works, For assistants
    and developers, Sample data) instead of to a block that no longer exists, so the chip still does
    something rather than landing on an empty target. The `/mcp` endpoint itself is unchanged and
    still fully documented — the connect command, the skills-first instruction, the tier contract —
    inside the "For assistants and developers" fold (P0-54's own machine contract), for whichever
    assistant or developer actually goes looking for it; only the top-level, open-at-rest pitch for
    it is retired.

    The bindings footnote (`bindingsLine`) also stopped naming which model answers — an
    implementation detail nobody using the chat needs, the owner's own words being "don't need to
    know which model is being used" — keeping only whether one is connected at all, since an unset
    `ANTHROPIC_API_KEY` is the one state where the chat silently just echoes and that much is worth
    knowing.

    **Superseded within the same session by P0-80**, which went further: not just the connect
    pitch but the whole reference accordion it pointed to, and "More Options" itself, are gone.

34a''''''''''. **`Test-PRD-P0-80-minimum_interface`** — The owner's own words, read back verbatim:
    "reduce the interface to the minimum necessary interface. No dev. No examples. No mcp. Just
    chat and common actions. Backed by skills." P0-79 had already retired the connect-your-own-
    assistant pitch but kept the reference accordion it used to point "More Options" at — Who has
    what (the roster), How this works, Something is not working, For assistants and developers
    (the whole MCP/tier/endpoint machine contract), Sample data. All of it is gone now, not
    re-folded: `ops/src/views.js`'s `opsPage` carries only the greeting, the chat widget, and the
    three one-click chips (Add Merchandise, Add Customers, Submit Expenses). "More Options" itself
    is retired along with it — there is nothing left on the page for a fourth chip to open.

    **Nothing here removes a real guarantee, only a page's static explanation of one** — every
    behaviour the accordion used to describe is enforced regardless of whether anyone reads a
    paragraph about it, and stays covered by its own test elsewhere: role derivation and its
    source (`ops/test/skills.test.mjs`'s `explainRole` checks), tool-count-per-role scoping
    (`ops/test/tools.test.mjs`), the T2-parks-and-returns-a-link contract
    (`ops/test/catalog-write.test.mjs`, `ops/test/assets-route.test.mjs`,
    `ops/test/approvals.test.mjs`), and the skills-first connect protocol
    (`ops/test/skills.test.mjs`, `ops/test/agent-greeting.test.mjs`). At the time this was
    written, the `/mcp` endpoint was unchanged and still fully documented in the developer fold
    for whichever assistant went looking for it — **since superseded by P0-81, which removed
    `/mcp` itself rather than leave it undocumented but reachable.** "Backed by skills" as
    written here meant the agent conversing over `/ops/agent` or `/mcp` both carried the full
    contract; P0-81 is the follow-through once only one of those two callers was left.

    `readRoster`, `sessionBindings`/`skillsFor`/`ROLES.map` for page display, `bindingsLine`,
    `rosterRows` and `opsShifts` are deleted from `ops/src/index.js` and `ops/src/views.js` rather
    than left unreachable — none had a caller once the sections that used them were gone.

34a'''''''''''. **`Test-PRD-P0-81-skills_over_mcp`** — The owner's own words: "MCP is probably
    only for me. Even then. I don't think I'll need it." The `/mcp` endpoint — its handler
    (`ops/src/mcp.js`), the checked-in `.mcp.json` Claude Code registration, and the
    `@modelcontextprotocol/server` dependency — is deleted outright, not merely left off the page
    the way P0-80 left it. The built-in chat (`/ops/agent`, already the sole one-click path since
    P0-68) is now the only way anything talks to these tools at all.

    **Deleting MCP would have deleted skills too, by accident, if nothing moved.** Skills
    (`skills/*/SKILL.md` — the category-set, price/publish-gate and upload-ticket knowledge a
    tool name alone does not carry) had exactly one reader: an MCP client's `skills_list` /
    `skills_read` tool calls. `ops/src/skills.js` had no other caller. Removing MCP without
    wiring skills in anywhere else would have left `skills.js` and nine `SKILL.md` files as dead
    weight nothing ever executes — the opposite of "Good skills," which was the owner's own next
    sentence in the same message. So `agent.js`'s tool loop gained the same two meta-tools an MCP
    client always had, `skills_list` and `skills_read`, handled in `dispatch()` before either name
    ever reaches `runTool()` — they touch no store and need no audit row. `systemPrompt()` now
    carries the "read the skills first" instruction `buildInstructions()` used to.

    **Filtering moves with it, not a rule of its own.** `skillsFor(role, canUseDomain)`
    (`skills.js`) is unchanged — dependency-injected on purpose, per its own comment, so it holds
    no opinion about roles. What changed is which `canUseDomain` it is handed: MCP's own
    (`roleCanUse`/`TIER_FLOOR`/`DOMAIN_FLOOR`, a rule this codebase had never reconciled with the
    built-in chat's own `mayUse`/`MAX_TIER`) is gone along with the endpoint; `agent.js` now
    exports its own `canUseDomain`, derived from `allowedTools()` — the same function that already
    decides which TOOLS this role's chat can call — so a skill for a domain the built-in chat
    cannot reach is never one this codebase's own rule disagrees with itself about.

    **What survived the split, and why.** `parkForApproval`/`peekPending`/`approvePending` were
    never MCP-specific — `batch.js`'s CSV upload flow and the `/approvals/<id>` page both reached
    them the whole time, MCP was only one more caller — so they move to a new `ops/src/approvals.js`
    rather than disappear with the rest of `mcp.js`. `roleCanUse` and its constants move with them,
    since `approvePending` re-checks an approver's role against it; nothing new consumes it.
    `canUseDomain`/`toolsFor` (MCP's tool-listing helpers) and everything protocol-shaped
    (`buildInstructions`, `buildServer`, `handleMcp`, `isMcpPath`, the OAuth discovery responses)
    have no reader left anywhere and are deleted outright.

    P0-62's greeting-menu-order guarantee (`buildInstructions()`'s own tests) is not a lost check:
    `greetingScript()` was always shared verbatim with `systemPrompt()`, already independently
    covered end to end by `ops/test/agent-greeting.test.mjs`, which is the one surface left to
    carry it. `ops/test/mcp-instructions.test.mjs` is deleted with `mcp.js` itself, and the
    `ops/test/skills.test.mjs`/`ops/test/catalog-write.test.mjs`/`ops/test/customer-create.test.mjs`/
    `ops/test/approvals.test.mjs` imports that reached `mcp.js` are repointed at `agent.js` and
    `approvals.js`. `ops/test/agent-skills.test.mjs` is new: `skills_list`/`skills_read` through
    `dispatch()` directly, `canUseDomain` cross-checked against `mayUse()` tool-by-tool, and (as
    it read at the time — see P0-82) the system prompt's own skills-first instruction, the same
    "assert what it sends, not what the code means" standard `ops/test/agent-tool-schema.test.mjs`
    already set for `toolDefinitions()`.

34a''''''''''''. **`Test-PRD-P0-82-skills_on_demand`** — The owner's own words, immediately
    after asking for MCP's removal: "minimize confusion... solve common problems and present
    most likely solution... minimizing churn and token use." P0-81's own `systemPrompt()` change
    had made `skills_list` then `skills_read("agent-tool-contract")` a MANDATORY first step —
    two guaranteed tool round-trips, and their token cost, before even a one-line lookup like
    "how many black coats are in stock." That is the churn the owner was describing, for a
    document whose operational content (the greeting, the tier/approval framing) was already
    inline in `systemPrompt()`/`greetingScript()` and cost nothing to read there.

    **The fix is the instruction, not the mechanism.** `skills_list`/`skills_read` still exist,
    unchanged, in `dispatch()` — a domain skill (catalog rules, price/publish gates, an upload
    flow) is real, non-duplicated knowledge a tool's name and description do not carry, and the
    model should still reach for one when it is actually unsure. What changed is `systemPrompt()`
    no longer tells it to read one FIRST, reflexively, on every turn: it names the tool and says
    to use it "when you are genuinely unsure, not a ritual to run before every call — try the
    most likely correct action first." A wrong first guess is cheap (the tool refuses and says
    why, the model tries again informed); a mandatory read before every single turn is not.

    Checked by asserting what the prompt actually says, the same standard `ops/test/agent-tool-
    schema.test.mjs` already set for `toolDefinitions()`: `skills_read` must still be named, but
    "before your first write/call" and "call skills_list, then skills_read" must both be gone.

34a'''''''''''''. **`Test-PRD-P0-83-quick_prompts_route_through_chat`** — The owner's own words:
    "I want them to go to chat. And I want chat to have a skill to address these as efficiently
    as possible." The three one-click chips (P0-69) were plain links straight to `/products/batch`,
    `/customers/batch` and `/expenses/new` — real routes, but a second entry point bypassing the
    assistant entirely. They are now `<button data-prompt="...">` elements: a click fills the chat
    input with a canned first message ("Add merchandise," "Add customers," "Submit an expense")
    and submits the same form the person would have typed into by hand, reusing the existing
    submit handler rather than a second fetch path.

    **Chat is the one entry point now, so a click has to cost the same one round-trip a typed
    message would, not two.** Landing at a chat with the person's choice already typed is not
    the same as landing at a chat that still has to ask what they want: `greetingScript()` gained
    a clause naming exactly this — a first message that already names a choice ("Add
    merchandise" or similar) skips the greeting-menu step entirely and goes straight to whatever
    comes next for that choice (P0-62's own second question, or the expense link), greeting the
    person by name in that same reply rather than as a separate turn first. Submit Expenses still
    resolves in exactly one round-trip either way — no second question exists for it (P0-66) — so
    a click there costs no more than the direct link it replaced.

    The routes themselves (`batchUploadPage`, `receiptUploadPage`) are unchanged and unlinked from
    nowhere else: chat still points a person at them once it knows which one applies (a
    spreadsheet, or a receipt photo), the same way `greetingScript()` already told a connecting
    agent to. Checked over the real page (`data-prompt` present with the right text, the old
    `href`s gone) and over `greetingScript()`'s own text (the new skip-the-menu clause present).

34a''''''''''''''. **`Test-PRD-P0-84-efficient_drafting`** — The owner's own words: "I want chat
    to ask all the right questions to add products. As efficiently and smoothly as possible...
    if not, we learn from our mistakes and refine the skill." Auditing `catalog.draft_product`'s
    and `catalog.create_product`'s own schema against what a person is likely to actually say
    (the composer's own placeholder: `"Add a wool coat, $450, Outerwear"`) found two real gaps
    between "required argument" and "a person should be asked":

    - **`currency` is required on every variation, with no schema default and no `CAPS` constant**
      for it anywhere in the codebase — every seed fixture and every price example in this
      repository is USD, and there is no multi-currency path to choose between. A person who
      never mentioned currency has nothing to say if asked; the only correct behaviour is the
      model defaulting to `"USD"` on its own.
    - **A product with no real size/color options still needs one `variation` object**
      (`validateProposal`'s own message: *"a single-size garment still needs one, conventionally
      titled 'One size'"*) — but that guidance only ever reached the model AFTER a refusal, not
      on the first attempt.

    **The fix lives in the tool's own `describe` text, not a skill.** P0-82 made `skills_read`
    on-demand rather than a mandatory first step, which means a model confident it has enough
    information (title, price, category) may never read `catalog-skills` at all before calling
    `catalog.draft_product` — exactly the case this gap needed fixing for. A tool's `describe`
    string is sent on every single request, unconditionally, the same way `create_product`
    already said "`category_id` MUST come from catalog.categories" inline rather than leaving it
    to a skill someone might skip. So both tools now say plainly: default to USD without asking;
    use one variation titled "One size" for a product with no real options; and — since
    `draft_product` still requires a `description` argument the model must supply something for
    — write a short one from the title/category/photo rather than asking the person to dictate
    one. What IS worth asking stays exactly three things: what it is, the price, and (only if it
    truly has them) the sizes or colors.

    Checked directly against `TOOLS[name].describe`, the same "assert what it sends" standard
    this file keeps returning to — not against a skill document a real call might never read.

34a'''''''''''''''. **`Test-PRD-P0-85-chip_skill_trigger`** — The owner's own words: "Each chip
    should contain a keyword that will trigger evaluating a skill... + Products is a good
    trigger." The deliberate exception to P0-82: a quick-prompt chip (P0-83) is a known,
    high-stakes entry point — a person is about to draft a real commercial write — so leaving
    whether to read the matching skill to the model's own confidence is the wrong call here,
    unlike free-form text where it usually is not. `agent.js`'s `buildUserContent` matches the
    message against an exact-phrase table (`"Add products"` → `catalog-skills`, `"Add customers"`
    → `customer-skills`) and, on a match, appends a plain instruction naming the skill to read —
    server-side, after the person's own chat bubble is already rendered, so what they see stays
    the clean chip text and only the model receives the pointer.

    **Exact phrase, not a keyword search.** A message that merely mentions "products" in passing
    ("how many products are low on stock") is a read, not a draft, and forcing a skill open on
    every message containing a common word would reintroduce exactly the churn P0-82 removed.
    Only the chip's own literal phrase matches — the same phrase `greetingScript()`'s own
    skip-the-menu clause (P0-83) already treats as a deliberate choice, not a coincidence of
    wording. The hint is appended, never substituted: the person's actual words still reach the
    model unchanged, first.

34a''''''''''''''''. **`Test-PRD-P0-86-surfaced_model_errors`** — The owner reported a live 400
    from the model, twice, with nothing to go on beyond "I'm still getting 400" — twice, because
    the actual Anthropic error detail (which tool, which argument, what shape it expected) was
    reaching only a Worker log neither of us could tail live, while the chat itself showed only
    "The model service returned 400." `agent-tool-contract`'s own audit-before-return rule
    applies here too, one level up: a call to Anthropic that fails is a call this codebase should
    account for as legibly as a call to Square that fails, not swallow into a bare status code.

    `callClaude()`'s error branch now parses Anthropic's own error body
    (`{type:"error", error:{type, message}}`) and puts `error.message` — the one line that
    actually names the field, tool or shape that was wrong — into the chat reply itself,
    truncated to 500 characters so a pathological body cannot flood the chat. A body that is not
    that shape (a proxy's own HTML error page, say) falls back to the raw text, truncated to 300;
    a body that is not JSON at all never throws attempting to parse it. The full, untruncated body
    is still logged server-side as before — this adds a second, visible destination, it does not
    remove the first.

    **This is the fix for the SYMPTOM, not (yet) a confirmed fix for the underlying 400** — its
    root cause was never actually seen by either the owner or this session, only inferred and
    guessed at twice already (the tool-schema fix, P0-76, was a different, confirmed 400; this
    one's cause is still unknown). The point of this change is that the next occurrence is
    self-diagnosing: whoever sees it can read the exact reason in the chat itself and act on it
    immediately, rather than reporting "still 400" a third time.

    First real test coverage of `callClaude()`'s own error path (previously: none, noted openly
    in P0-68's own PRD entry) — `ANTHROPIC_BASE_URL`, the override this file already shipped for
    exactly this purpose, points at a local HTTP server shaped like Anthropic's real error
    responses, no live network call or API key involved.

    **Superseded within the same session by P0-87**, which found and fixed the actual cause this
    entry called unknown: every tool name in this registry has a dot, and Anthropic's own tool
    name grammar has never allowed one.

34a'''''''''''''''''. **`Test-PRD-P0-87-wire_safe_tool_names`** — P0-86's own fix worked exactly
    as designed: the very next 400 was self-diagnosing. The owner pasted back Anthropic's own
    message — `tools.2.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'` — and
    it named the real, confirmed cause of "still getting 400" directly. Every tool in this
    registry is named `domain.verb` (`catalog.create_product`, `customer.profile`, …), a
    convention baked in from the very first commit, and Anthropic's grammar has never permitted
    the dot. **Every single real tool call had been 400ing since the day a live key was first
    configured** — P0-76's schema-shape fix was necessary but not sufficient; nothing in this
    codebase had ever driven `agentTurn()` against a live Anthropic call to notice the name
    itself was equally illegal, because nothing mocked the Messages API at all until P0-86.

    **The fix touches only the API boundary, deliberately.** `agent.js` exports `wireName(id) =>
    id.replace(/[^a-zA-Z0-9_-]/g, "_")` — `catalog.create_product` → `catalog_create_product`.
    `toolDefinitions()` itself is UNCHANGED and still returns the real, dotted names: every other
    caller in this codebase (tests, `TOOLS` lookups, the old bindings footnote) depends on that,
    and MCP's own now-deleted `wireName` (`ops/src/mcp.js`, ADR-017) already established the
    precedent of converting only at the wire and mapping back on the way in — its comment even
    named this exact grammar for OpenAI's function names, without anyone having verified
    Anthropic's own tool names needed the identical treatment until this bug forced the check.
    `agentTurn()` builds a `nameForWire` reverse-lookup alongside the wire-renamed `tools` array
    it actually sends, and translates a `tool_use` block's name back to the real one before
    `dispatch()`, `TOOLS` lookups, the pending-approval record, or an audit step ever see it — the
    person only ever sees `catalog.create_product` in what this page or a log shows them; only
    the literal bytes on the wire to Anthropic are ever `catalog_create_product`.

    No two tool names collide once converted (checked directly, not merely assumed) — true today
    because every domain prefix is a single word with no underscore of its own, so `.` is always
    the sole character `wireName` touches. Checked by driving `agentTurn()` against a fake HTTP
    server shaped like Anthropic (P0-86's own technique, extended to inspect the REQUEST body
    rather than only a canned response): every tool name actually sent matches Anthropic's
    pattern, and a `tool_use` reply naming a tool by its wire form dispatches and reports the
    real, dotted name in `steps` — not a "no such tool" refusal, which is what an untranslated
    wire name would have produced.

34a''''''''''''''''''. **`Test-PRD-P0-88-spreadsheet_via_chat`** — The owner's own words: "When I
    upload a spreadsheet to the agent I expect it to process and generate the preview,
    interpreting all of the column headings for me. Not going through the dumb uploading
    pathway! I want the chat to be the main interface!" Before this, a dropped `.csv` reached the
    model as a wall of raw extracted text (the generic file-attachment note every other document
    type already got) — a model doing its own ad hoc column-matching and price parsing on
    free-form text, with none of the closed-category-set validation or per-row approval linking
    `/products/batch` and `/customers/batch` already do deterministically. That generic path is
    "the dumb uploading pathway" the owner meant.

    **The fix reuses the tested logic, it does not reinvent it.** `agent.js` gains two meta-tools
    — `catalog_draft_product_batch`, `customer_draft_customer_batch` — that call the SAME
    `draftProductBatch()`/`draftCustomerBatch()` (`ops/src/batch.js`) the dedicated upload pages
    call directly: identical column-heading matching (title/name/item/style, category, price,
    description, sku — any reasonable spelling), identical validation against the closed category
    set and the price format, identical one-T2-approval-link-per-clean-row output. A spreadsheet
    dropped in chat gets the exact same "preview" — ready rows with their links, skipped rows with
    their plain reasons — just narrated conversationally instead of behind a page visit, which is
    the "interpreting all of the column headings for me" and "generate the preview" the owner
    asked for in the same breath.

    **Manager+ only, matching the tier of what these mint.** `catalog.create_product` and
    `customer.create` are both manager-gated (P0-60's own rule, mirrored here rather than
    re-decided); the two meta-tools are added to the tool list `agentTurn()` sends only when
    `canDraftBatches(role)` is true, and `dispatchBatchDraft()` re-checks the same rule as
    defense in depth — the same "second enforcement of the same set" principle already governing
    every other tool in `dispatch()` (P0-24).

    **The CSV text itself is never re-typed by the model, the same reason a photo's bytes never
    are (P0-77).** `ingestAgentAttachment` (`ops/src/index.js`) already stores an uploaded
    non-image file in the `assets` store and extracts its text at upload time; the meta-tool takes
    only the `asset_id` and reads the text back from that row itself. `attachmentNote()`
    (`ops/agent.js`) recognises a `.csv`/`text/csv` attachment for a role that can reach these
    tools and points at them by name instead of dumping the extracted text inline — a coworker
    without that role still gets the honest, unchanged plain-text note, since they could not call
    the batch tools regardless.

    Checked by driving `dispatch()` itself, the same "assert what it sends/does, not what the code
    means" standard this file keeps returning to: the role gate refuses staff plainly, a missing
    `ASSETS` binding or an unknown or textless asset id all refuse with a clear reason rather than
    throwing, a real CSV against the same fixture `draftProductBatch()`'s own tests use produces
    the identical ready/skipped split with a real approval URL, and the `CAPS.BATCH_MAX_ROWS` cap
    reports itself plainly rather than drafting a partial batch.

34a'''''''''''''''''''. **`Test-PRD-P0-89-batch_preview_confirm`** — The owner's own words, the
    same turn P0-88 shipped: "The agent should confirm with me about its selections if it is
    unsure. Giving me a brief preview of the first row and headings before generating the actual
    product or client ingestion tables. These should appear below the chat in compact format that
    is easy to review and full screen... (Auto scrolling)." P0-88's two draft meta-tools mint a
    real T2 approval link per clean row the moment they run — a wrong column match was not one
    mistake to fix, it was up to `CAPS.BATCH_MAX_ROWS` approval links to click through or cancel
    one at a time, discovered only after the fact.

    **A preview that mints nothing, ahead of a draft that mints everything.** `batch.js` gains
    `previewBatch(text, kind)` — read-only, reusing the exact same `pick()`/key-list column
    matching `draftProductBatch`/`draftCustomerBatch` use, but on the first `PREVIEW_SAMPLE_ROWS`
    (3) rows only: no `listCategories` call, no `runTool`, no `parkForApproval`. "Just top 2 or 3
    rows to see the headings" — the owner's own words, once a first version previewing only row 1
    was actually in front of them — is why 3 rather than 1: enough to see the mapping hold across
    more than a single row, not the whole sheet. `agent.js` exposes it as two more meta-tools,
    `catalog_preview_product_batch`/`customer_preview_customer_batch` (same manager+ gate as the
    draft tools, same `asset_id` argument), and `attachmentNote()`'s spreadsheet pointer now names
    the preview tool first: call it, show the person the detected headings and how the sampled
    rows map to title/category/price/etc (or given_name/email/phone/…), and only call the draft
    tool once they confirm the mapping looks right. Nothing here forces the sequence at the API
    layer — the model could still call the draft tool directly — the ordering is instructed, the
    same trust boundary `agent-tool-contract`'s other "ask only a genuine choice" guidance already
    runs on.

    **A structured `table`, not just prose, is the point of "compact format... full screen."** A
    person cannot review 40 rows of skip reasons rendered as one text bubble. The preview table's
    columns are the real detected headings (`title`, `category`, `price`, …) with one row per
    sampled record — a normal spreadsheet snippet, not a field-by-field list — and the draft
    tools' own table is `Row`/`Title`/`Status`/`Detail`, one row per actual CSV row. Both return a
    `table: {title, columns, rows}` alongside their text summary — `dispatch()` passes it through
    as a sibling of the `tool_result` block,
    and `agentTurn()` tracks the most recent one across the round-trip loop (`lastTable`) so it
    rides along on the turn's own final `{mode, actor, role, steps, reply, table}` shape even
    though the actual tool call may not be the model's very last step. `index.js`'s existing
    `{...turn}` spread over the JSON response needed no change at all to carry it.

    **Rendered inline with the chat, not a separate panel.** `views.js`'s client script gains
    `tableCard()`, appended into the SAME `#log` element the message bubbles already live in —
    the existing `log.scrollTo({top: log.scrollHeight, behavior:"smooth"})` call that already
    fires after every bubble now carries the table into view too, for free, rather than needing a
    second scroll target to keep in sync. A "Full screen" button toggles one CSS class
    (`.table-card.full`) that switches the same element to a fixed, viewport-covering overlay and
    back — one element, one piece of state, no second copy of the table to keep matching the
    first.

    **Scrolls sideways rather than squeezing a real approval URL into an unreadable wrapped
    column.** The owner's own words, once the table was actually in front of them: "the ability
    to scroll the element sideways if it exceeds the chat box width." The table keeps its natural
    column widths (`width: max-content` inside a `min-width: 100%` card, cells `white-space:
    nowrap`) instead of being forced to the card's own width with wrapped text — a wide table
    scrolls horizontally within the same card that already scrolls vertically for a long row
    count, with the title and "Full screen" button pinned in place (`position: sticky; left: 0`)
    so they stay reachable while scrolled right.

34a''''''''''''''''''''. **`Test-PRD-P0-90-daylight_contrast`** — The owner's own words: "Bump up
    the contrast of the dimmer elements on ops page. Its a little hard to see on a mobile device
    in broad daylight." Direct sun washes out exactly the mid-tones a "dim, secondary" colour is
    built from — a ratio that reads comfortably indoors can still disappear outside, which a ratio
    computed against an indoor assumption never catches.

    **`--muted` and `--rule` (P0-75's own dark-reskin tokens) were both raised, nothing else.**
    `--muted` (secondary text — the chat log's tool-step asides, the composer hint, table headers
    and labels, the attach-file name, a disabled gate button) went from `#9C978C` — already a
    passing 6.1:1 against `--ground` but only 5.4:1 against `--image-ground`, the panel background
    it also sits on (`.table-card`, `.who`) — to `#B8B3A8`, which clears 7:1 (WCAG AAA for normal
    text) against BOTH. `--rule` (every border and divider — the chat bar's own outline, a table's
    row lines, the approval gate's box, a copy button's outline) went from `#3A3733`, a bare 1.5:1
    against `--ground` and effectively invisible as a boundary, to `#7B7369`, clearing 3:1 (WCAG's
    own non-text/UI-component minimum) against both backgrounds it appears on. `--ink`, `--ground`,
    `--image-ground` and `--accent` were already comfortably above their own thresholds (15.3:1,
    5.7:1 respectively) and are untouched — the report was about the DIM elements specifically, not
    the whole palette.

    Checked by computing the same relative-luminance contrast formula the WCAG spec itself defines
    (not a hardcoded "looks fine" assertion) against both `--ground` and `--image-ground` for each
    token, so a future edit that quietly drifts a colour back under its floor fails the same way a
    missed feature would.

34a'''''''''''''''''''''. **`Test-PRD-P0-91-quiet_greeting`** — The owner's own words: "Center the
    welcome heading too (Hi Dimitri — what would you like to do?) And make it less prominent
    (bright) also remove the 'ask the ops assistant' line." Two redundant "first thing on the
    page" signals were both fighting for the same attention the chat widget itself (P0-74) is
    supposed to get: a bold, full-bright, left-aligned name greeting, immediately followed by a
    second heading that only restated what the widget right below it obviously already was.

    `.greet` is now centred (`text-align: center`) and its `<h1>` drops from `font-weight: 700` in
    `--ink` (15.3:1, the page's brightest possible text) to `font-weight: 400` in `--muted`
    (P0-90's own freshly-raised 7:1 token) — still perfectly legible, no longer the loudest thing
    on the screen. The `<h1>Ask the ops assistant</h1>` inside `.key.chat-top` is deleted outright
    rather than restyled — a heading that only names what a chat box already visibly is was pure
    restatement, not information — and the two CSS rules that existed solely to style it
    (`.key h1`, `.chat-top h1`) are removed with it rather than left as dead rules nothing renders.

34a''''''''''''''''''''''. **`Test-PRD-P0-92-chat_widget_accent`** — The owner's own words: "Make
    the chat window border same orange color as the quick chat pills. Make the + button in chat
    box and chat entry line a little brighter too" — then, on being asked to confirm which
    "entry line" they meant: "The border of chat entry line i mean." Three separate elements had
    all been drawn in the same flat `--rule` neutral every other box on the page uses, which read
    as visually disconnected from `.choices .btn`'s own orange outline directly below the widget,
    and dim enough next to it that the attach icon and the composer's own outline both nearly
    disappeared.

    `.chat-top` (the widget's own outer frame) goes from a `--rule` border to `var(--accent)` —
    literally the same token `.choices .btn` already borders itself in, so the widget and the
    quick-prompt chips beneath it now read as one accent family rather than two unrelated boxes.
    `.chat .chat-bar` (the composer pill itself — "the entry line") goes from `--rule` to
    `var(--muted)` — brighter, but a plain neutral rather than a second orange box nested inside
    the first, so the two borders stay visually distinct rather than doubling up. The `+` attach
    icon (`.chat .chat-bar .icon-btn`) goes from `--muted` to `--ink` at rest — full brightness,
    matching the composer's own send icon and typed text — with its hover state moved from `--ink`
    to `--accent` so hovering still reads as a distinct state now that the resting colour is no
    longer the dim one. (The attach icon's own styling moves on again in P0-95 — a filled circle
    matching the send button's own treatment, not just a brighter glyph on a transparent one.)

34a'''''''''''''''''''''''. **`Test-PRD-P0-93-nested_chat_frame`** — Immediate follow-up to
    P0-92, once the accent frame was actually in front of the owner. Their own words: "Keep the
    inner chatbox a gray color when highlighted. I want it to have less padding on the sides and
    bottom. Make it even with the outer chat border with slightly smaller radius so that inner
    chat box container fits neatly into the outer (orange) edge... This means that the bottom
    outer edge radius is bigger than it currently is."

    **Focus no longer spends the one accent colour on a ring that was already inside one.**
    `.chat .chat-bar:focus-within` moves from `border-color: var(--accent)` to `var(--ink)` — a
    focused composer nested inside the now-orange `.chat-top` frame (P0-92) doubling that same
    orange as its own focus ring said nothing an already-orange frame had not; `--ink` still reads
    as a distinct, brighter "active" state without borrowing the frame's own colour.

    **Less padding, and an intentionally UNEQUAL gap — tightened twice.** `.chat-top`'s padding
    goes from a uniform `14px` to `14px 8px 8px` (top/right/bottom shorthand: right and bottom
    inherit the third value, left is set by the fourth positional value being absent so it
    repeats the second — in effect top 14px, sides and bottom both 8px) — tight and even on the
    sides and bottom the owner named, while the top keeps its own 14px since the hint/log stack
    sits there, not the composer pill. A direct follow-up tightened it again: "I would even reduce
    the padding from 8 to 4px - to tighten the inner chat and outer edge gap" — `14px 4px 4px`,
    top still untouched.

    **The radius geometry took two attempts to get right, and the pill's own radius never actually
    needed to change.** A first pass shrank `.chat .chat-bar`'s own radius from `24px` to `18px`
    and grew `.chat-top`'s bottom corners to `26px` to stay concentric with that shrunken value —
    reverted on the spot: "Dont change the inner chat radius! I liked how it flowed around the
    chat buttons!" The bigger `24px` radius is what lets the pill's own curve flow continuously
    into the round icon buttons (32-34px circles) sitting inside it, not a mismatch to correct
    toward the frame's own smaller radius. A second pass over-corrected the other way, reverting
    `.chat-top` to a plain uniform `20px` as well — which dropped the "bottom outer edge radius is
    bigger" idea entirely rather than just fixing which radius it was measured against. The
    owner's own clarification named the actual intent precisely: "the bottom of the outer chat box
    edge radius is slightly bigger than the inner chat edge so that it has a neat, even padding
    (same idea as the chat send button fitting inside of the inner chat box)" — the SAME concentric
    idea as the first attempt, just computed against the pill's real, unchanged `24px` radius
    rather than the mistaken `18px`. `.chat .chat-bar` stays `24px`, untouched throughout; `.chat-
    top`'s radius was `20px 20px 32px 32px` against the original `8px` gap (`24 + 8 = 32`), then
    recomputed to `20px 20px 28px 28px` (`24 + 4 = 28`) once the gap itself was tightened further
    to `4px` above.

    **A THIRD round was needed — the per-corner split itself was the bug, not just its numbers.**
    Even `20px 20px 28px 28px` still rendered visibly uneven on a real phone: "Make sure there is
    an even gap between chat and outer edges!!! Make sides match the bottom!" The root cause both
    earlier rounds missed: `.chat .chat-bar`'s DECLARED `24px` radius never actually renders at
    `24px`. The bar is only about `42px` tall (`4px + 4px` padding plus a `34px` button), and CSS
    caps `border-radius` at half a box's own dimension once the declared value would exceed it — a
    full stadium either way, visually, but the pill's TRUE rendered radius is `~21px`, not the
    nominal `24` every prior round of arithmetic here used. `21 + 4 = 25` is what is actually
    concentric with the pill's real shape — and rather than keep tracking a separately-computed
    "smaller top, bigger bottom" split that has now produced a visible mismatch twice, `.chat-top`
    moves to ONE uniform `25px` on every corner. Top corners being slightly rounder than their old
    `20px` costs nothing (nothing rounded is nested against them to begin with), and removing the
    per-corner distinction entirely is what actually keeps the gap the same width all the way
    around — sides included — the way the owner asked for from the start.

    **What the owner actually wanted instead: even padding around the send button.** `.chat-bar`'s
    own padding was `4px 4px 4px 6px` — 6px on the left (in front of the attach icon), only 4px on
    the right (behind the send button), so the send button sat measurably tighter against the
    bar's own edge than the attach button did on the other side. It becomes `4px 6px` (top/bottom
    4px, left AND right 6px) — the send button now has the same clearance the attach button always
    had, "fit better" being exactly the plain, correct way to describe closing a two-pixel
    asymmetry nobody had a reason for in the first place.

    **A further round tightened both gaps once more, together.** The owner's own words: "Submit
    buttons padding / chat radius could use a bit of tightening too. Button feels like it could
    use a slight nudge to the right or the inner chat edge has a tiny bit uneven padding on the
    sides." The actual numbers were already even on both sides (`.chat .chat-bar`'s `4px 6px` is a
    genuine 6px/6px split, `.chat-top`'s `14px 4px 4px` a genuine 4px/4px one) — the send button
    likely reads as sitting closer to the frame than the attach button simply because it shares
    the frame's own orange, an optical effect rather than a numeric bug this time. Rather than
    introduce a deliberate asymmetry to chase that impression, both gaps were tightened together,
    which brings both buttons closer to their own edge and keeps them exactly matched: `.chat
    .chat-bar`'s own padding drops from `4px 6px` to a uniform `4px` (the button's own padding, as
    named); `.chat-top`'s sides/bottom drop from `4px` to `3px`. `.chat-top`'s radius is
    recomputed for the new gap using the same formula as before — `pillRadius (21, the pill's true
    rendered shape) + thisGap` — from `21 + 4 = 25px` to `21 + 3 = 24px`.

34a''''''''''''''''''''''''. **`Test-PRD-P0-94-mobile_edge_to_edge`** — The owner's own words:
    "Overall reduce the overall page padding on the sides and let the chat fill more of the
    horizontal space. I want to maximize the use of space on mobile devices." `.ops`'s own side
    padding (`24px`) was the single biggest unused margin on a phone screen — width neither the
    chat widget, the log, nor anything else on the page could ever use, on the narrowest screens
    this page is asked to fit on at all.

    `.ops`'s padding goes from a uniform-feeling `12px 24px 32px` to `12px 8px 32px` — top and
    bottom unchanged, sides matching `.chat-top`'s own already-tightened `8px` side padding
    (P0-93), so the page edge and the widget edge now read as one consistent margin rather than
    two different ones stacked on top of each other. `max-width: 64rem` is untouched, so a wide
    desktop window still caps the content column the same way it always did — the difference is
    negligible there and material only on the narrow screens the request was actually about.

34a'''''''''''''''''''''''''. **`Test-PRD-P0-95-filled_attach_button`** — The owner's own words:
    "Brighten the bg color of the + button on the left side of chat entry field. Make sure that
    it also flows neatly inside of the inner chat border (like the chat submit button)." The
    attach icon (P0-92) had already gone from a dim `--muted` glyph to a bright `--ink` one, but
    stayed a bare glyph on a transparent background — visually a different kind of control from
    `.send-btn`'s own solid, filled accent circle sitting in the bar's other rounded end.

    `.chat .chat-bar .icon-btn` becomes a `34px` circle (up from `32px`, matching the send
    button's own size so both round buttons nest into the bar's left and right ends identically) —
    the SIZE half of "flows neatly... like the chat submit button" stands. The FILL half went
    through a direct correction: a first pass gave it the exact treatment `.send-btn` already has
    — an opaque `--ink` background with a `--ground` glyph on top, `.send-btn:hover`'s own
    `opacity: 0.85` — which read as a second bold, competing circle rather than a quieter sibling
    to Send. The owner's own words once it was in front of them: "A faint gray fill for the
    attachment button. Needs to be just a little brighter than the bg." It becomes a translucent
    white overlay, `rgba(255, 255, 255, 0.08)` at rest over the bar's own `--image-ground`,
    brightening to `0.16` on hover — "a little brighter than the bg," read literally, rather than
    an opaque colour of its own — with the glyph itself staying `--ink` (bright) since the fill
    underneath it is faint rather than solid. The `aria-pressed="true"` state (an attachment
    currently staged) reverts to its own original faint accent tint, `rgba(217, 119, 87, 0.14)`,
    for the same reason: an opaque `--accent` fill would have been the one loud circle this entry
    was correcting away from, just recoloured.

1. **`Test-PRD-P1-01-agent_read_tools`** — Natural-language read across catalog, orders,
   inventory, schedule and knowledge, scoped by the caller's bindings.
2. **`Test-PRD-P1-02-agent_scheduling`** — Managers build, amend and publish shifts
   conversationally; the overlap guarantee (P0-18) is what makes this safe to expose.
3. **`Test-PRD-P1-03-agent_catalog_pr`** — Catalog and pricing edits are made by the agent
   **opening a pull request**: the platform supplies the approval gate, the reviewable diff and
   the audit history for free, and revert is a revert.
4. **`Test-PRD-P1-04-knowledge_semantic_search`** — Vectorize-backed semantic search over the
   knowledge library, rebuildable from Git.
5. **`Test-PRD-P1-05-second_adapter`** — A second commerce adapter ships with **no schema
   migration** — the real test of P0-16.
6. **`Test-PRD-P1-06-pos_channel`** — A live POS channel, with the customer-matching key
   (email or phone) decided *before* import, since merging duplicate customer records
   retroactively is genuinely unpleasant.
7. **`Test-PRD-P1-07-projection_reconciliation`** — A nightly job reconciles our catalog and
   stock against the provider's copy and alerts on drift.
8. **`Test-PRD-P1-08-customer_retention_policy`** — A retention period applied to `customers`
   as well as `identity`. De-identified is *pseudonymous*, not anonymous: at luxury scale
   "bought that £9,000 coat, size IT 42, born 1985" may still be one person.
9. **`Test-PRD-P1-09-kek_rotation`** — KEK backup and rotation tooling: rotation re-wraps data
   keys and updates `kek_id`; it does not re-encrypt customer data. Policy must exist before the
   first customer record is written; losing the KEK loses every identity.
10. **`Test-PRD-P1-10-notes_governance`** — `customer.notes` is free text and will accumulate
    names unless something stops it: encrypt it, or govern it explicitly as identifying data.

---

## 5. Non-goals

- **Not building checkout or payments.** PCI scope, fraud and tax are deliberately rented from
  the commerce provider. This is the one accepted dependency.
- **Not building a ledger.** Books of record stay in Xero/QuickBooks; `finance` exists so the
  agent can reason about spend.
- **Not building payroll.** Gusto/Deel. We hold scheduling, not compensation.
- **Not a Shopify theme.** The Dawn fork in this repo is superseded by G3.
- **Not one database.** A central store is not a simplification here; it is a shared blast
  radius with a single retention policy.
- **Not storing card data**, ever, in any store.
- Not multi-tenant, not a public API, not a mobile app — for v1.

---

## 6. Users

| Persona | Needs | Access |
|---|---|---|
| **Customer** | Browse products, buy | Public storefront |
| **Staff** | View and swap own shifts, look up orders and stock | `ops`, staff role |
| **Manager** | Build schedules, edit catalog and pricing, approve agent writes | `ops`, manager role |
| **Owner** | Everything, plus finance views and audit history | `ops`, owner role |

Roles derive from **Google Workspace groups**, surfaced through Cloudflare Access Groups and
referenced by each application's policy. No role is assigned inside the app, so offboarding
someone in Workspace revokes platform access with no application-side change.

Store reachability, per ADR-002:

| Store | Who reaches it |
|---|---|
| catalog, knowledge, reports | All staff (via PR review) |
| commerce | Staff (read), managers (write) |
| customers | Staff (profile), managers (write) |
| **identity** | Clienteling tools only, under their own policy |
| finance | Managers and owner |
| **people** | Owner and the individual employee |
| audit | Owner (read); application is insert-only |

---

## 7. Non-functional requirements

- **N1** Storefront p75 LCP < 2.0s on 4G mobile.
- **N2** Storefront reads never block on a provider API.
- **N3** Provider outage degrades checkout only; browsing stays fully available.
- **N4** All money stored as integer minor units with explicit currency. No floats.
- **N5** Customer identifiers encrypted at the application layer with the KEK outside the
  database provider. Employee PII behind its own Access policy.
- **N6** Infrastructure cost target < $50/month at launch scale, excluding model usage.
- **N7** **No single database.** Catalog, knowledge and reports are Git — the most portable
  format available, more portable than any SQL engine. Operational data is per-domain D1, kept
  to plain SQL so a store is restorable into any SQLite-compatible engine.
- **N8** A KMS dependency sits on the identity read path — AWS KMS, one KEK, ~$1–5/month
  (ADR-006); a managed PII vault is not warranted while checkout is rented and we hold no card
  data. Unwrapped data keys are cached in memory per request and **never persisted**.
- **N9** Every operation spanning two stores is **idempotent and retryable**, because it cannot
  be atomic.
- **N10** Migrations and backups are per-store: six D1 migration trails, three Git histories.
  That repetition is the accepted price of §3.1.

---

## 8. The Exit Test — how G2 is verified

Provider independence is a claim that rots silently unless tested. It is therefore a **CI check**,
run on every change to the data layer and reviewed quarterly:

1. Load every store schema into a scratch database and seed a product, variant and provider.
2. Delete the provider: the `external_ref` keys in the catalog JSON, and the provider's rows and
   `external_id` values in `commerce`.
3. **Assert:** catalog, media, orders, schedule and finance are intact; every vendor identifier
   is gone; the storefront still builds and renders the catalog.

A failing Exit Test blocks merge. If we cannot delete the provider in CI, we cannot delete it in
production either.

The store-level half of this drill is implemented in `shared/db/verify.py` and passes today.

---

## 9. Architecture summary

Full detail in [`cloudflare-architecture.md`](./cloudflare-architecture.md).

```
  GIT  (versioned, reviewable, publishable, no PII)
    catalog/    products, collections, content, vendor id mappings
    knowledge/  reference library  ──embed on commit──►  Vectorize (derived)
    reports/    sharded by period
        │
        │ static build
        ▼
  vemians.com ── Astro on Workers, our design, R2 media ──► checkout URL only ──┐
                                                                                │
  D1  (concurrent, erasable, constraint-enforcing)                              ▼
    identity   name/email/phone as ciphertext   ◄── KEK in external KMS   ┌────────────┐
    customers  profile, fit, consent, versions                            │  Provider  │
    commerce   orders, lines, inventory  ◄──── webhooks (orders) ─────────│ Shopify/POS│
    people     employees, shifts         ──── projection (catalog) ──────►└────────────┘
    finance    expenses, budgets                                     via the commerce port
    audit      append-only agent record
        │
        └──► ops.vemians.com   browser chat + /mcp, Access via Google Workspace,
                                 one binding per store
```

No store is central. No foreign key crosses a boundary. `identity` is reachable only by
clienteling tools; erasing one row there de-identifies a customer everywhere at once.

**Why D1 rather than Postgres:** the portability argument favoured Postgres mainly to protect
the catalog, and the catalog now lives in Git, which protects it better. What remains is small
and operational, and seven bindings in `wrangler.toml` at near-zero cost is exactly what D1 is
good at. The one thing given up — `EXCLUDE USING gist` for shift overlap — is recovered by a
trigger, race-free because D1 serialises writes to a single writer (P0-18).

---

## 10. Acceptance criteria for v1

- [ ] An employee signs in at `ops.vemians.com` with their Workspace account, with no
      app-specific credential.
- [ ] Removing that employee from Google Workspace revokes access, verified.
- [ ] A manager builds a week's schedule conversationally; a double-booking attempt is refused
      by the database, not by the prompt.
- [ ] A manager changes a price conversationally; it arrives as a pull request, is merged by a
      human, rebuilds the storefront, projects to the provider, and appears in the audit log.
- [ ] A customer erasure request deletes the identity row, the profile, the fit data, the consent
      and the change history — and the orders remain, intact and anonymous.
- [ ] A clienteling tool reads a customer's fit profile **without** being able to see who it is.
- [ ] The storefront renders the full catalog with the provider API unreachable.
- [ ] A customer completes a purchase; the order lands in `commerce`, normalised, once, even if
      the webhook is replayed.
- [ ] `python3 shared/db/verify.py` and the Exit Test both pass in CI.

---

## 11. Milestones

| # | Milestone | Exit condition |
|---|---|---|
| M0 | Six D1 schemas + `verify.py` + Exit Test in CI | Green on every commit |
| M1 | Git stores + derived index | Catalog, knowledge and reports build from shards |
| M2 | Storefront on our catalog | Grid and imagery contract met, provider unplugged |
| M3 | KMS, envelope encryption, identity vault | KEK backup and rotation policy in place |
| M4 | Commerce port + Shopify adapter | Catalog projects out; orders ingest in, idempotently |
| M5 | `ops` shell + Google SSO + audit log | Sign-in works; zero tools shipped |
| M6 | Read-only agent tools | Staff query catalog, orders, stock within their bindings |
| M7 | Scheduling | Managers build schedules conversationally |
| M8 | Gated write tools | PR gate, approval gate and caps enforced |
| M9 | Finance and POS integrations | Read-only mirrors; POS as a channel |

M3 ships **before the first customer record is written** — the KEK policy cannot be
retrofitted. M5 ships **before any tool**: the audit log must exist before the first action it
records.

---

## 12. Test contract

Per `RULES.md`:

- Tests exist to enforce the numbered features above, not implementation details.
- Python check names use `test_PRD_P0_NN_short_id__specific_behaviour`; other frameworks preserve
  the visible `Test-PRD-P0-NN-short_id` label. (`NN` and `short_id` are the feature's, above —
  the placeholder is written with `NN` here deliberately, so it never reads as a real label.)
- Every PRD-backed test file opens with a header block stating this contract.
- A behaviour change moves the PRD feature and its labeled test **in the same change**.
- Unlabeled tests are not acceptable.

Where each feature is enforced today:

| Features | Enforced by |
|---|---|
| P0-01, P0-05 – P0-21, P0-30 | `shared/db/verify.py` |
| P0-02 – P0-04 | Build-time catalog/knowledge/report checks (M1) |
| P0-22 – P0-25 | Access policy review + `ops` integration tests (M5) |
| P0-54 | `ops/test/skills.test.mjs`, `ops/test/ops-page.test.mjs` |
| P0-55 | `ops/test/media-square.test.mjs`, over a stubbed Square uploader |
| P0-59 | `ops/test/media-new.test.mjs`, over the real Worker |
| P0-60 | `ops/test/csv.test.mjs` for the parser; the product-batch half of `ops/test/catalog-write.test.mjs`; the customer-batch half of `ops/test/customer-create.test.mjs`; `ops/test/batch-route.test.mjs` for both HTTP routes |
| P0-70 | the flexible-header half of `ops/test/catalog-write.test.mjs` |
| P0-61 | `ops/test/customer-create.test.mjs`, over a fake Square client — no Square account, token or network call is involved |
| P0-62 | `ops/test/mcp-instructions.test.mjs` |
| P0-63 | the editable-approval half of `ops/test/catalog-write.test.mjs`, over the real Worker (`worker.fetch`) |
| P0-64 | `ops/test/skills.test.mjs` |
| P0-65 | `ops/test/tools.test.mjs` for the tool layer and extraction; `ops/test/assets-route.test.mjs` for the upload/download/list routes, over the real Worker |
| P0-66 | `ops/test/tools.test.mjs` for `parseReceiptText` and the OCR fallback; `ops/test/expenses-route.test.mjs` for the scan/confirm/file routes, over the real Worker; `ops/test/mcp-instructions.test.mjs` and `ops/test/skills.test.mjs` for the "no tool, send them to the link" instruction |
| P0-67 | `ops/test/skills.test.mjs` for `firstNameFrom` and `buildInstructions()`; no round-trip test yet exercises `skills_list`'s wire response directly — this file has no harness that calls a registered MCP tool handler, for any tool, not only this one |
| P0-68 | `ops/test/agent-greeting.test.mjs` for `systemPrompt()`'s greeting; no test yet drives `agentTurn()` end to end (the whole file has no test coverage of the Anthropic call loop itself, not only the greeting) |
| P0-69 | `ops/test/ops-page.test.mjs`, over the real Worker |
| P0-71 | `ops/test/catalog-write.test.mjs` for `catalog.set_channel`; the channel-filter half of `store/test/storefront.test.mjs` |
| P0-72 | the product-detail half of `store/test/storefront.test.mjs`, over the real mirror schema |
| P0-73 | `ops/test/media-backfill.test.mjs` for the fetch-and-store job; the real-photo half of `store/test/storefront.test.mjs` for rendering and the hover-alt fallback rule |
| P0-74 | `ops/test/ops-page.test.mjs` |
| P0-75 | `ops/test/ops-page.test.mjs` |
| P0-76 | `ops/test/agent-tool-schema.test.mjs` |
| P0-77 | `ops/test/agent-attachments.test.mjs` |
| P0-78 | `ops/test/ops-page.test.mjs` |
| P0-79 | `ops/test/ops-page.test.mjs` |
| P0-80 | `ops/test/ops-page.test.mjs` |
| P0-81 | `ops/test/agent-skills.test.mjs`, plus the repointed imports in `ops/test/skills.test.mjs`, `ops/test/catalog-write.test.mjs`, `ops/test/customer-create.test.mjs`, `ops/test/approvals.test.mjs` |
| P0-82 | `ops/test/agent-skills.test.mjs` |
| P0-83 | `ops/test/ops-page.test.mjs`, `ops/test/agent-greeting.test.mjs` |
| P0-84 | `ops/test/catalog-write.test.mjs` |
| P0-85 | `ops/test/agent-skills.test.mjs` |
| P0-86 | `ops/test/agent-model-errors.test.mjs` |
| P0-87 | `ops/test/agent-tool-wire-names.test.mjs` |
| P0-88 | `ops/test/catalog-write.test.mjs` |
| P0-89 | `ops/test/catalog-write.test.mjs`; no test yet drives the `views.js` client script's `tableCard()` rendering directly — this file has no browser/DOM harness for any client-side script, not only this one |
| P0-90 | `ops/test/ops-page.test.mjs` |
| P0-91 | `ops/test/ops-page.test.mjs` |
| P0-92 | `ops/test/ops-page.test.mjs` |
| P0-93 | `ops/test/ops-page.test.mjs` |
| P0-94 | `ops/test/ops-page.test.mjs` |
| P0-95 | `ops/test/ops-page.test.mjs` |
| P0-56, P0-57 | `store/test/site.test.mjs`, plus the drawer half of `store/test/storefront.test.mjs` |
| P0-58, and the contact-form half of P0-26/P0-37 | `store/test/contact.test.mjs`, over a stubbed Square client — no Square account, token or network call is involved |
| P0-50, P0-51, P0-52, P0-53 | `ops/test/authz.test.mjs` for the fail-closed and cache behaviour; a structural check over both `wrangler.toml` files and all Worker source for the binding and API-token bans |
| P0-26 – P0-28 | Storefront build checks and the CI image-weight budget (M2) |
| P0-42 – P0-46 | `store/test/storefront.test.mjs`, plus a Playwright run against `wrangler dev --local` for the measured browser behaviour (CLS, computed transforms and durations, focus order) |
| P0-49, and the storefront half of P0-24, P0-37 and P0-47 | `store/test/storefront.test.mjs` |
| P0-48 | `ops/test/sync.test.mjs`, over the real mirror schema with a stubbed provider client |
| P0-37, P0-39 | `shared/commerce/square/test/square.test.mjs` |
| P0-29 | The Exit Test in CI |

---

## 13. Open questions

1. **Domain** — is it `vemians.com`? Everything above assumes so.
2. **Existing data** — is there a live Shopify store with products and order history to
   migrate, or do we start clean?
3. **Shopify plan** — checkout customisation and some headless features vary by tier.
4. **Team size** — sets the Cloudflare Access tier and the scheduling model.
5. **Catalog scale** — hundreds of SKUs or tens of thousands? Changes the sync design.
6. **Launch date** — is there a date the storefront must be live?
7. **Provider intent** — is Shopify the launch provider, or is a switch already planned?
   Affects whether M4 builds one adapter or two.

---

## 14. Risks

| Risk | Mitigation |
|---|---|
| Checkout dependency is real lock-in | Accepted and scoped. Catalog and customers stay ours |
| Losing the KEK loses every customer identity | Backup and rotation policy before the first record (M3, P1-09) |
| KMS on the identity read path adds latency and a failure mode | Per-request in-memory key cache; only clienteling tools touch it |
| Pseudonymous ≠ anonymous at luxury scale | Retention period on `customers`, not just `identity` (P1-08) |
| Nine stores means nine migration and backup paths | Accepted; the alternative is one shared blast radius |
| Eventual consistency across stores | Every cross-store operation idempotent and retryable (N9) |
| Projection drift between our stores and the provider | Nightly reconciliation and drift alerts (P1-07) |
| Agent takes a damaging action | PR gate, in-session approval, caps, append-only audit, destructive ops absent |
| Free-text notes accumulate identifiers | Encrypt or govern (P1-10) |
| Publishing pipeline leaks a Git store | No PII may enter Git at all — the rule is the mitigation (P0-04) |
| Cloudflare lock-in replacing Shopify lock-in | Catalog in Git; plain SQL in D1; standard web framework |
