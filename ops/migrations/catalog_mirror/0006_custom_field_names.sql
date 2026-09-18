-- A global list of custom field NAMES, administered once from the Admin
-- panel instead of invented ad hoc while editing one product. See
-- shared/commerce/square/schema.sql's own comment on mirror_custom_field_name
-- for the full reasoning; this is the delta half of that change.

CREATE TABLE mirror_custom_field_name (
  name        TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
