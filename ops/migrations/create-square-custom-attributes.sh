#!/usr/bin/env bash
#
# One-time: create Square's own CatalogCustomAttributeDefinition objects for
# style_id, vendor and commission (Test-PRD-P0-136-square_custom_attributes),
# so that catalog.set_square_attributes (ops/src/tools/catalog-write.js) has
# something real to set a VALUE against. Without this, the very first attempt
# to set any of the three fails at Square with an unknown-attribute error —
# the definition has to exist before any item can carry a value for it.
#
# Run this ONCE per Square account (sandbox and production are separate
# accounts, so once each), by a human who holds the real SQUARE_ACCESS_TOKEN —
# same reasoning apply-local.sh gives for why there is no --remote flag on a
# development script: this is a real, permanent, account-level write, typed by
# a person who means it, not something CI or an agent runs unattended.
#
#   SQUARE_ACCESS_TOKEN=... SQUARE_ENV=production ./create-square-custom-attributes.sh
#
# Idempotent: lists existing CUSTOM_ATTRIBUTE_DEFINITION objects first and
# skips a key that is already there, so running this again (a second
# location, a token rotated, unsure whether it ran before) is safe.
#
# Both are created VISIBILITY_READ_WRITE_VALUES — seller-visible AND editable
# right on Square's own Edit Item page, not just readable. The owner's own
# words, having weighed that against keeping this ops-only: "we don't mind
# having our stuff being stored completely in Square... we can also restrict
# editing custom attributes inside of Square as well" — a deliberate choice,
# not an oversight; Square's own team-permissions decide who can edit these
# directly in Square's Dashboard from here on, the same way Square's own
# permissions already govern price and title edits at the till.
set -euo pipefail

: "${SQUARE_ACCESS_TOKEN:?SQUARE_ACCESS_TOKEN must be set to a real Square access token}"
: "${SQUARE_ENV:?SQUARE_ENV must be set to 'sandbox' or 'production'}"

case "${SQUARE_ENV}" in
  sandbox)    BASE_URL="https://connect.squareupsandbox.com" ;;
  production) BASE_URL="https://connect.squareup.com" ;;
  *) echo "ERROR: SQUARE_ENV must be 'sandbox' or 'production', got '${SQUARE_ENV}'" >&2; exit 1 ;;
esac

# Pinned to the same date this codebase's own client.js uses everywhere else
# (shared/commerce/square/client.js), so this script's own request shape is
# never tested against a different Square API version than the app is.
SQUARE_VERSION="2026-08-19"

echo "── existing CUSTOM_ATTRIBUTE_DEFINITION objects on this account ──"
EXISTING="$(curl -sS "${BASE_URL}/v2/catalog/list?types=CUSTOM_ATTRIBUTE_DEFINITION" \
  -H "Authorization: Bearer ${SQUARE_ACCESS_TOKEN}" \
  -H "Square-Version: ${SQUARE_VERSION}")"
echo "${EXISTING}" | python3 -c '
import json, sys
d = json.load(sys.stdin)
for o in d.get("objects", []):
    print(o["id"], o.get("custom_attribute_definition_data", {}).get("key"))
' || true

create_if_missing() {
  local key="$1" name="$2" description="$3"
  if echo "${EXISTING}" | python3 -c "
import json, sys
d = json.load(sys.stdin)
keys = [o.get('custom_attribute_definition_data', {}).get('key') for o in d.get('objects', [])]
sys.exit(0 if '${key}' in keys else 1)
"; then
    echo "── '${key}' already exists — skipping ──"
    return 0
  fi

  echo "── creating '${key}' ──"
  RESPONSE="$(curl -sS "${BASE_URL}/v2/catalog/object" \
    -X POST \
    -H "Authorization: Bearer ${SQUARE_ACCESS_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Square-Version: ${SQUARE_VERSION}" \
    -d "{
      \"idempotency_key\": \"create-custom-attr-${key}-$(date +%s)\",
      \"object\": {
        \"type\": \"CUSTOM_ATTRIBUTE_DEFINITION\",
        \"id\": \"#${key}\",
        \"custom_attribute_definition_data\": {
          \"type\": \"STRING\",
          \"key\": \"${key}\",
          \"name\": \"${name}\",
          \"description\": \"${description}\",
          \"visibility\": \"VISIBILITY_READ_WRITE_VALUES\"
        }
      }
    }")"
  echo "${RESPONSE}" | python3 -m json.tool
  echo "${RESPONSE}" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if "errors" in d:
    print("ERROR: Square refused this definition", file=sys.stderr)
    sys.exit(1)
'
}

create_if_missing "style_id" "Style ID" \
  "This shop's own nomenclature: NN-NN-NNN (2-digit category, 2-digit subcategory, 3-digit item number), e.g. 01-04-001. Set from ops.vemians.com's Items tab."
create_if_missing "vendor" "Vendor" \
  "Which vendor supplied this product. Set from ops.vemians.com's Items tab."
create_if_missing "commission" "Commission" \
  "Integer 0-100: the percentage this shop keeps when it sells a vendor's product. Only applies to a product that has a vendor. Set from ops.vemians.com's Items tab."

echo "── done ──"
