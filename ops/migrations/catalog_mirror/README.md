# catalog_mirror migrations

Ordered, forward-only SQL deltas for the `vemians-catalog-mirror` D1
database, applied automatically in CI on every push to `main`
(`.github/workflows/deploy-workers.yml`, step "Migrate catalog mirror
schema", `wrangler d1 migrations apply CATALOG_MIRROR --remote`) — BEFORE the
Worker code that expects the new shape deploys, so the mirror is never
missing a column the code that reads it already assumes exists.

This is the ONE exception to this repository's usual rule that a production
schema change is a human typing `wrangler d1 execute --remote`
(`ops/migrations/apply-local.sh`'s own comment). It earned the exception
because it is the one store that keeps changing shape as this feature set
grows, and hand-running the same kind of fix after every deploy stopped
being acceptable — the owner's own words: "having to manually run shit every
time I add a custom field is unacceptable."

## The rule this imposes

**Every time `shared/commerce/square/schema.sql` changes, add a NEW file
here too, in the same PR, numbered one higher than the last
(`0002_whatever.sql`, `0003_whatever.sql`, ...).** The new file is the DELTA
— `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE`, `DROP VIEW` + `CREATE VIEW`
for any index view whose underlying table just changed shape, `ALTER TABLE
... DROP COLUMN` for a column being retired — never the whole schema again.
`wrangler d1 migrations apply` tracks which files have already run (in its
own `d1_migrations` table, inside `vemians-catalog-mirror` itself) and only
runs the new ones, in filename order, exactly once each, ever. A file
already applied must never be edited — fix a mistake with another new file,
the same as you would with a bad commit already pushed to a shared branch.

`shared/commerce/square/schema.sql` itself stays the single canonical FULL
schema — tests (`shared/test/d1.mjs`'s `d1FromSql`) and local dev
(`apply-local.sh`) still load it whole, in one shot, unchanged by any of
this. Keep it in sync with the delta you just wrote: after your new
migration file lands, `schema.sql` should describe the exact same end state,
by hand-editing it the same way this feature's other changes always have.
Nothing enforces that the two agree — it is on you (or whoever reviews the
PR) to notice if they drift.

## Bootstrapping a genuinely fresh database

`0001_baseline.sql` is a snapshot of `schema.sql` as it stood the day this
migrations directory was created — production was already at that exact
shape by then (through the string of hand-run fixes this whole scheme
exists to end), so it was never actually run there; a one-time manual step
recorded it as applied directly in `d1_migrations` instead. A genuinely new
`vemians-catalog-mirror`-shaped database (a fresh environment, a rebuild
from zero) bootstraps normally: `wrangler d1 migrations apply` runs
`0001_baseline.sql` for real, then every numbered file after it, and ends up
at the identical schema either way.

## Supersedes bootstrap-d1.yml's one-off ADD COLUMN inputs

`.github/workflows/bootstrap-d1.yml` already runs `wrangler d1 execute
--remote` against this exact database (schema bootstrap on a fresh
database, plus a manually-triggered one-off `add_channel_column` step for a
database that predated that column) — proof `CLOUDFLARE_API_TOKEN` already
carries D1 write access, and that this team already tolerates CI touching
production D1 schema. That one-off pattern does not scale past one column
(imagine a new boolean input for every future change) and needs a human to
open the Actions tab and tick a box on every use — this migrations
directory is what that pattern was reaching for. Do not add another
one-off input there for a catalog_mirror change; add a numbered migration
file here instead.
