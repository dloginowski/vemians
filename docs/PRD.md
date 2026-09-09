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
    changed. Receipts live in R2, never inline.

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
    to mint a checkout URL, and keeps our handles as stable URLs across a provider switch.
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
37. **`Test-PRD-P0-43-restrained_motion`** — Motion is a budget, not a feature: **150–250ms, ease-out,
    transform and opacity only**. No parallax, no bounce, no scroll-triggered reveal, no shadow that
    appears on scroll, no `!important`. Every duration in the storefront resolves from **one pair of
    custom properties**, and `prefers-reduced-motion: reduce` remaps that pair to `0s` — so the
    computed `transition-duration` on every animated element is `0s` and the transition is **removed,
    not shortened**, while every state change still happens, instantly.
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
    document. **One thing is open at rest** — the identity line and the copyable `claude mcp add`
    command — because connecting an assistant is what nearly everyone is there to do, once. The
    roster, the tier rules, the troubleshooting, the machine-readable contract and the seed data are
    **closed accordion rows in small print**, ordered by how many people will ever open them. The
    whole page fits a phone screen without scrolling. Folding costs the machine reader nothing: a
    `<details>` is in the DOM whether or not a person opened it, so an assistant that fetches the
    URL still gets the endpoint, the skill names readable at that role, the tier rules and the
    tools bound to it. The endpoint is **derived from the request host**, never typed, so a preview
    deployment cannot hand a visitor a command pointing at production. The tool counts shown come
    from the same registry that filters the calls, so the page cannot advertise a capability the
    tool layer would refuse. Checked by `ops/test/ops-page.test.mjs`, which fetches the real page
    from the real Worker rather than asserting over the template.

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

## 4. P1 features

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
