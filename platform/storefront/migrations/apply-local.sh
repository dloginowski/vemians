#!/usr/bin/env bash
#
# Load platform/db/*.sql into the LOCAL D1 databases for development.
#
#   npm run db:local              apply every store
#   npm run db:local -- audit     apply one store
#   npm run db:local -- --reset   drop the local D1 state first, then apply
#
# Local only, by construction: every wrangler call below carries --local, which
# targets the miniflare SQLite files under .wrangler/state and never touches a
# real database. There is deliberately no remote mode here — applying a schema
# to production is `wrangler d1 execute --remote` typed by a human who meant it,
# not a flag on a development script.
#
# The schemas are NOT idempotent (plain CREATE TABLE), so re-applying one fails
# with "table already exists". That is the correct behaviour for a store whose
# whole point is that migrations are per-store and ordered — use --reset when
# you want a clean local database.
#
# Each store is applied to its OWN database, in its own call. There is no
# combined schema and no shared connection: no foreign key and no transaction
# crosses a store boundary (Test-PRD-P0-01-store_topology), and a runner that
# concatenated the files would quietly make that possible.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"          # platform/storefront
DB_DIR="$(cd "${ROOT}/../db" && pwd)"     # platform/db

# The six stores, in dependency-free order — they have none, by design. The
# order below is the one PRD §3.1 lists them in.
STORES=(customers identity commerce people finance audit)

RESET=0
WANTED=()
for arg in "$@"; do
  case "${arg}" in
    --reset) RESET=1 ;;
    --help|-h) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "unknown flag: ${arg}" >&2; exit 2 ;;
    *) WANTED+=("${arg}") ;;
  esac
done
if [ "${#WANTED[@]}" -gt 0 ]; then
  STORES=("${WANTED[@]}")
fi

WRANGLER=(npx --no-install wrangler)
if ! "${WRANGLER[@]}" --version >/dev/null 2>&1; then
  echo "ERROR migrations: wrangler is not installed — run 'npm ci' in platform/storefront" >&2
  exit 1
fi

if [ "${RESET}" = "1" ]; then
  echo "reset: removing ${ROOT}/.wrangler/state/v3/d1"
  rm -rf "${ROOT}/.wrangler/state/v3/d1"
fi

cd "${ROOT}"
for store in "${STORES[@]}"; do
  schema="${DB_DIR}/${store}.sql"
  if [ ! -f "${schema}" ]; then
    echo "ERROR migrations: no schema at ${schema}" >&2
    exit 1
  fi
  binding="$(echo "${store}" | tr '[:lower:]' '[:upper:]')"
  echo "── ${store}  ->  binding ${binding} (local)"
  # --env ops because the bindings live on the ops Worker and nowhere else.
  "${WRANGLER[@]}" d1 execute "${binding}" \
    --env ops \
    --local \
    --file "${schema}" \
    --yes >/dev/null
done

echo
echo "applied: ${STORES[*]}"
echo "state:   ${ROOT}/.wrangler/state/v3/d1"
echo "check:   npx wrangler d1 execute AUDIT --env ops --local --command \\"
echo "           \"SELECT name FROM sqlite_master WHERE type='table'\""
