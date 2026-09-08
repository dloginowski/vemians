-- D1: identity  -- the ONLY store holding direct identifiers.
--
-- This is the vault half of the split you asked for. Everything else in the
-- platform holds an opaque customer id; names, emails and phone numbers exist
-- here and nowhere else. Deleting a row here de-identifies the customer across
-- every other store at once, without touching them.
--
-- ON HASHING (see ADR-004)
--   A plain hash of a name or phone number is NOT anonymisation. Phone numbers
--   have ~10^10 possibilities and names far fewer, so an unsalted digest is
--   brute-forced in seconds. Under GDPR Recital 26 a re-identifiable hash is
--   still personal data. Hence: encrypt, do not hash.
--
--   Values below are ciphertext from application-level envelope encryption. The
--   data key is per-customer and wrapped by a KEK held in an EXTERNAL KMS, so
--   the database provider cannot read this table. Destroying the wrapped key
--   crypto-shreds that customer irreversibly.

CREATE TABLE customer_identity (
  customer_id     TEXT PRIMARY KEY,          -- the opaque id used everywhere else

  -- Ciphertext. Never queryable, never logged, never rendered into a build.
  name_enc        BLOB,
  email_enc       BLOB,
  phone_enc       BLOB,

  -- Deterministic lookup handles. HMAC-SHA256 under a secret key held with the
  -- KEK, NOT a bare hash: an unkeyed digest of an email is trivially reversed
  -- by dictionary attack, a keyed one is not without the secret.
  email_hmac      BLOB UNIQUE,
  phone_hmac      BLOB UNIQUE,

  -- Envelope: the per-customer data key, wrapped by the external KEK.
  wrapped_dek     BLOB NOT NULL,
  kek_id          TEXT NOT NULL,             -- which KEK version wrapped it
  crypto_shredded INTEGER NOT NULL DEFAULT 0,

  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Once the key is destroyed the ciphertext must go too; keeping it serves no
-- purpose and looks like retention. This enforces that the pair stay consistent.
CREATE TRIGGER identity_shred_clears_ciphertext
AFTER UPDATE OF crypto_shredded ON customer_identity
WHEN NEW.crypto_shredded = 1
BEGIN
  UPDATE customer_identity
     SET name_enc = NULL, email_enc = NULL, phone_enc = NULL,
         email_hmac = NULL, phone_hmac = NULL, wrapped_dek = x'',
         updated_at = datetime('now')
   WHERE customer_id = NEW.customer_id;
END;
