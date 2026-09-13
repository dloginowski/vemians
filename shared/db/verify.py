#!/usr/bin/env python3
"""
Store guarantees — PRD-backed regression checks.

    Run: python3 shared/db/verify.py     (exit 0 = all checks passed)

────────────────────────────────────────────────────────────────────────────────
PRD / TEST CONTRACT — read before editing this file
────────────────────────────────────────────────────────────────────────────────
`docs/PRD.md` is the driving design document. Every check here exists to enforce
a NUMBERED PRD FEATURE as written there — not an implementation detail, and not
"a thing the schema happens to do".

  * Each check is a function named  test_PRD_P0_NN_short_id__specific_behaviour
    which yields the visible label  Test-PRD-P0-NN-short_id.
  * That label MUST exist in docs/PRD.md. The last check in this file
    (P0-30) enforces exactly that, so an invented or renamed label fails the run
    instead of drifting silently.
  * UNLABELED CHECKS ARE NOT ACCEPTABLE. A new guarantee needs a PRD feature
    first; if there is no feature for it, write the feature.
  * When behaviour changes, the PRD feature and its labeled check move in the
    SAME change as the schema. A schema edit with a stale PRD is a process
    failure, not a follow-up.

Mechanics: each schema is loaded into its own in-memory SQLite database
(D1 is SQLite), and the checks run in file order against those connections.
`@rejects` marks a check that PASSES only when the database refuses the
statement; `@holds` marks one that passes when it succeeds.
────────────────────────────────────────────────────────────────────────────────
"""
import pathlib
import re
import sqlite3
import sys

HERE = pathlib.Path(__file__).parent
PRD = HERE.parents[1] / 'docs' / 'PRD.md'
STORES = ('identity', 'customers', 'commerce', 'people', 'finance', 'audit')

ok = True
total = 0
labels = []          # every PRD label exercised, in order
NAME = re.compile(r'^test_PRD_(P[01])_(\d{2})_([a-z0-9_]+?)__([a-z0-9_]+)$')


def db(name):
    """Load one store's schema into its own database. No store shares a connection."""
    c = sqlite3.connect(':memory:')
    c.executescript("PRAGMA foreign_keys=ON;" + (HERE / f'{name}.sql').read_text())
    return c


def cols(conn, table):
    return [r[1] for r in conn.execute(f"PRAGMA table_info('{table}')")]


def tables(conn):
    return [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]


def _run(fn, expect_fail):
    """Run one labeled check. Decorators call this at definition time, so the
    checks execute in file order and may build on each other's fixtures."""
    global ok, total
    m = NAME.match(fn.__name__)
    if not m:
        print(f"  FAIL  {fn.__name__}   <-- not a PRD-labeled check "
              f"(expected test_PRD_P0_NN_short_id__behaviour)")
        ok = False
        return fn
    prio, num, short_id, behaviour = m.groups()
    label = f"Test-PRD-{prio}-{num}-{short_id}"
    if label not in labels:
        labels.append(label)
    try:
        fn()
        passed, detail = not expect_fail, '' if not expect_fail else 'expected rejection, was accepted'
    except sqlite3.Error as e:
        passed, detail = expect_fail, '' if expect_fail else str(e)
    except AssertionError as e:
        passed, detail = False, str(e) or 'assertion failed'
    total += 1
    ok &= passed
    print(f"  {'PASS' if passed else 'FAIL'}  {label}  ::  {behaviour.replace('_', ' ')}"
          + (f"   <-- {detail}" if detail else ''))
    return fn


def holds(fn):
    """The statement must succeed."""
    return _run(fn, expect_fail=False)


def rejects(fn):
    """The statement must be refused by the database."""
    return _run(fn, expect_fail=True)


# ─────────────────────────────────────────────────────────────────────────────
print("\ntopology  (P0-01: seven stores, none central, no boundary crossings)")
# ─────────────────────────────────────────────────────────────────────────────

@holds
def test_PRD_P0_01_store_topology__every_d1_store_schema_loads_independently():
    for name in STORES:
        conn = db(name)
        assert tables(conn), f"{name}.sql defined no tables"
        conn.close()


@holds
def test_PRD_P0_01_store_topology__no_foreign_key_crosses_a_store_boundary():
    for name in STORES:
        conn = db(name)
        own = set(tables(conn))
        for t in own:
            for fk in conn.execute(f"PRAGMA foreign_key_list('{t}')"):
                assert fk[2] in own, f"{name}.{t} has a FK to '{fk[2]}', outside its store"
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
print("\ncommerce  (orders survive the catalog, the vendor, and a replayed webhook)")
# ─────────────────────────────────────────────────────────────────────────────
c = db('commerce')
c.execute("INSERT INTO \"order\"(id,order_number,channel,external_id,currency)"
          " VALUES('o1',1,'shopify','gid/1','USD')")


@rejects
def test_PRD_P0_13_webhook_idempotency__a_replayed_webhook_cannot_duplicate_an_order():
    c.execute("INSERT INTO \"order\"(id,order_number,channel,external_id,currency)"
              " VALUES('o2',2,'shopify','gid/1','USD')")


@holds
def test_PRD_P0_13_webhook_idempotency__the_raw_payload_is_retained_for_replay():
    assert 'raw_payload' in cols(c, 'order'), "no raw_payload column: ingest cannot be replayed"


@holds
def test_PRD_P0_14_order_line_snapshot__a_line_persists_with_no_foreign_key_to_the_git_catalog():
    c.execute("INSERT INTO order_line(id,order_id,product_handle,title_snapshot,quantity,"
              "unit_price_minor,currency) VALUES('l1','o1','bone-tee','Bone Tee',1,4500,'USD')")


@holds
def test_PRD_P0_14_order_line_snapshot__the_line_carries_handle_title_and_price_snapshots():
    have = set(cols(c, 'order_line'))
    for col in ('product_handle', 'sku_snapshot', 'title_snapshot', 'unit_price_minor'):
        assert col in have, f"order_line is missing the {col} snapshot"


@rejects
def test_PRD_P0_14_order_line_snapshot__a_zero_quantity_line_is_rejected():
    c.execute("INSERT INTO order_line(id,order_id,product_handle,title_snapshot,quantity,"
              "unit_price_minor,currency) VALUES('l2','o1','x','X',0,1,'USD')")


@holds
def test_PRD_P0_15_money_minor_units__commerce_holds_no_floating_point_money_column():
    for t in tables(c):
        for r in c.execute(f"PRAGMA table_info('{t}')"):
            name, decl = r[1], (r[2] or '').upper()
            assert decl not in ('REAL', 'FLOAT', 'DOUBLE', 'NUMERIC'), \
                f"{t}.{name} is {decl}: money must be integer minor units"
            if name.endswith('_minor'):
                assert decl == 'INTEGER', f"{t}.{name} is {decl}, not INTEGER"


@holds
def test_PRD_P0_15_money_minor_units__every_money_bearing_table_carries_an_explicit_currency():
    for t in ('order', 'order_line'):
        have = {r[1]: r[3] for r in c.execute(f"PRAGMA table_info('{t}')")}
        assert have.get('currency') == 1, f"{t}.currency must exist and be NOT NULL"


@holds
def test_PRD_P0_16_commerce_port__external_id_is_the_only_vendor_field_in_the_store():
    vendorish = re.compile(r'external|vendor|shopify|provider|gid', re.I)
    found = {f"{t}.{col}" for t in tables(c) for col in cols(c, t) if vendorish.search(col)}
    assert found == {'order.external_id'}, f"vendor identifiers leaked into: {sorted(found)}"


# ─────────────────────────────────────────────────────────────────────────────
print("\ncustomers  (erasure is the whole point of this split)")
# ─────────────────────────────────────────────────────────────────────────────
cu = db('customers')
cu.execute("INSERT INTO customer(id,birth_year) VALUES('c1',1990)")


@holds
def test_PRD_P0_08_customers_no_identifiers__the_profile_store_holds_no_direct_identifier():
    present = {'email', 'phone', 'name'} & set(cols(cu, 'customer'))
    assert not present, f"identifier columns present: {sorted(present)}"


@holds
def test_PRD_P0_09_data_minimisation__age_is_stored_as_a_birth_year_not_a_date_of_birth():
    have = set(cols(cu, 'customer'))
    assert 'birth_year' in have, "birth_year missing"
    assert not {'dob', 'date_of_birth', 'birth_date'} & have, "full date of birth is over-collection"


@rejects
def test_PRD_P0_09_data_minimisation__an_implausible_birth_year_is_rejected():
    cu.execute("INSERT INTO customer(id,birth_year) VALUES('c9',1200)")


@rejects
def test_PRD_P0_09_data_minimisation__consent_for_an_unknown_purpose_is_rejected():
    cu.execute("INSERT INTO customer_consent(customer_id,purpose,granted,source)"
               " VALUES('c1','resale',1,'x')")


@holds
def test_PRD_P0_09_data_minimisation__consent_is_evidenced_per_purpose_with_a_source_and_time():
    have = set(cols(cu, 'customer_consent'))
    for col in ('purpose', 'granted', 'source', 'recorded_at'):
        assert col in have, f"customer_consent is missing {col}"


cu.execute("INSERT INTO customer_fit(customer_id,garment,size_label) VALUES('c1','tops','IT 42')")
cu.execute("INSERT INTO customer_consent(customer_id,purpose,granted,source)"
           " VALUES('c1','marketing',1,'checkout')")
cu.execute("INSERT INTO erasure_request(id,customer_id) VALUES('er1','c1')")
cu.execute("DELETE FROM customer WHERE id='c1'")


@holds
def test_PRD_P0_10_erasure_is_real__erasing_a_profile_cascades_to_fit_data():
    assert cu.execute("SELECT count(*) FROM customer_fit").fetchone()[0] == 0


@holds
def test_PRD_P0_10_erasure_is_real__erasing_a_profile_cascades_to_consent():
    assert cu.execute("SELECT count(*) FROM customer_consent").fetchone()[0] == 0


@holds
def test_PRD_P0_10_erasure_is_real__the_erasure_evidence_survives_the_erasure():
    assert cu.execute("SELECT count(*) FROM erasure_request").fetchone()[0] == 1


@holds
def test_PRD_P0_10_erasure_is_real__the_evidence_records_the_id_only_never_what_was_erased():
    have = set(cols(cu, 'erasure_request'))
    assert not {'email', 'phone', 'name', 'payload', 'snapshot'} & have, \
        "erasure evidence must not copy the data it erased"


@rejects
def test_PRD_P0_10_erasure_is_real__the_erasure_evidence_cannot_itself_be_deleted():
    cu.execute("DELETE FROM erasure_request")


# ─────────────────────────────────────────────────────────────────────────────
print("\nreversibility  (P0-12: non-destructive edits WITHOUT immutability)")
# ─────────────────────────────────────────────────────────────────────────────
cv = db('customers')
cv.execute("INSERT INTO customer(id,birth_year) VALUES('c2',1985)")
cv.execute("INSERT INTO customer_fit(customer_id,garment,size_label) VALUES('c2','tops','IT 40')")
cv.execute("INSERT INTO customer_version(customer_id,table_name,field,old_value,new_value,actor)"
           " VALUES('c2','customer_fit','size_label','IT 40','IT 42','ana@vemians.com')")
cv.execute("UPDATE customer_fit SET size_label='IT 42' WHERE customer_id='c2'")


@holds
def test_PRD_P0_12_reversible_edits__an_edit_is_recorded_with_actor_before_it_is_applied():
    row = cv.execute("SELECT old_value,new_value,actor FROM customer_version"
                     " WHERE customer_id='c2'").fetchone()
    assert row == ('IT 40', 'IT 42', 'ana@vemians.com'), f"change not recorded: {row}"


@rejects
def test_PRD_P0_12_reversible_edits__history_cannot_be_rewritten():
    cv.execute("UPDATE customer_version SET new_value='IT 50'")


cv.execute("INSERT INTO customer_version(customer_id,table_name,field,old_value,new_value,actor,"
           "reverts) VALUES('c2','customer_fit','size_label','IT 42','IT 40','ana@vemians.com',1)")
cv.execute("UPDATE customer_fit SET size_label='IT 40' WHERE customer_id='c2'")


@holds
def test_PRD_P0_12_reversible_edits__a_change_reverts_and_the_revert_is_itself_recorded():
    assert cv.execute("SELECT size_label FROM customer_fit"
                      " WHERE customer_id='c2'").fetchone()[0] == 'IT 40'
    assert cv.execute("SELECT count(*) FROM customer_version"
                      " WHERE reverts IS NOT NULL").fetchone()[0] == 1


@rejects
def test_PRD_P0_12_reversible_edits__history_is_not_deletable_without_an_erasure_request():
    cv.execute("DELETE FROM customer_version WHERE customer_id='c2'")


cv.execute("INSERT INTO erasure_request(id,customer_id) VALUES('er2','c2')")


@holds
def test_PRD_P0_12_reversible_edits__history_is_deletable_under_an_open_erasure_request():
    cv.execute("DELETE FROM customer_version WHERE customer_id='c2'")


# ─────────────────────────────────────────────────────────────────────────────
print("\nidentity  (the vault: ciphertext, an external KEK, and a keyed handle)")
# ─────────────────────────────────────────────────────────────────────────────
idn = db('identity')
idn.execute("INSERT INTO customer_identity(customer_id,name_enc,email_enc,email_hmac,"
            "wrapped_dek,kek_id) VALUES('c1',x'AA',x'BB',x'CC',x'DD','kek-1')")


@holds
def test_PRD_P0_05_identity_vault__identifiers_exist_only_as_ciphertext_columns():
    have = set(cols(idn, 'customer_identity'))
    plaintext = {'name', 'email', 'phone'} & have
    assert not plaintext, f"plaintext identifier columns present: {sorted(plaintext)}"
    for col in ('name_enc', 'email_enc', 'phone_enc'):
        assert col in have, f"{col} missing from the vault"


@rejects
def test_PRD_P0_05_identity_vault__a_row_cannot_be_written_without_the_kek_that_wrapped_it():
    idn.execute("INSERT INTO customer_identity(customer_id,name_enc,wrapped_dek)"
                " VALUES('c7',x'AA',x'DD')")


@holds
def test_PRD_P0_06_keyed_lookup_handle__lookup_is_a_keyed_hmac_not_a_bare_hash():
    have = set(cols(idn, 'customer_identity'))
    assert {'email_hmac', 'phone_hmac'} <= have, "no keyed lookup handles"
    assert not {'email_hash', 'phone_hash', 'name_hash'} & have, \
        "bare hash column: low-entropy digests are brute-forced, not anonymised"


idn.execute("UPDATE customer_identity SET crypto_shredded=1 WHERE customer_id='c1'")


@holds
def test_PRD_P0_07_crypto_shred__destroying_the_wrapped_key_clears_ciphertext_and_handles():
    r = idn.execute("SELECT name_enc,email_enc,email_hmac,length(wrapped_dek)"
                    " FROM customer_identity WHERE customer_id='c1'").fetchone()
    assert r == (None, None, None, 0), f"residue after shredding: {r}"


# ─────────────────────────────────────────────────────────────────────────────
print("\ncross-store  (P0-11: erasure versus tax retention)")
# ─────────────────────────────────────────────────────────────────────────────
c.execute("INSERT INTO \"order\"(id,order_number,channel,external_id,customer_id,currency)"
          " VALUES('o9',9,'pos','pos/1','c1','USD')")


@holds
def test_PRD_P0_11_erasure_vs_tax_retention__the_order_survives_the_customer_erasure():
    assert c.execute("SELECT count(*) FROM \"order\" WHERE id='o9'").fetchone()[0] == 1


@holds
def test_PRD_P0_11_erasure_vs_tax_retention__the_order_carries_no_pii_only_a_dangling_id():
    have = set(cols(c, 'order'))
    assert 'customer_id' in have, "no pseudonymous reference to the customer"
    leaked = {'email', 'phone', 'name', 'birth_year'} & have
    assert not leaked, f"PII columns present on the retained order: {sorted(leaked)}"


@holds
def test_PRD_P0_17_channel_agnostic_orders__a_pos_sale_is_just_another_channel():
    assert c.execute("SELECT channel FROM \"order\" WHERE id='o9'").fetchone()[0] == 'pos'


@holds
def test_PRD_P0_17_channel_agnostic_orders__no_card_data_column_exists_anywhere_in_commerce():
    banned = re.compile(r'\b(pan|card_number|cardnumber|cvv|cvc|expiry|track_data)\b', re.I)
    found = {f"{t}.{col}" for t in tables(c) for col in cols(c, t) if banned.search(col)}
    assert not found, f"card data would put the platform in PCI scope: {sorted(found)}"


# ─────────────────────────────────────────────────────────────────────────────
print("\npeople  (P0-18: the database refuses a double booking, not the prompt)")
# ─────────────────────────────────────────────────────────────────────────────
p = db('people')
p.execute("INSERT INTO employee(id,email,name) VALUES('e1','ana@vemians.com','Ana')")
p.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at)"
          " VALUES('s1','e1','2026-09-08T09:00Z','2026-09-08T17:00Z')")


@rejects
def test_PRD_P0_18_no_double_booking__an_overlapping_shift_is_refused_on_insert():
    p.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at)"
              " VALUES('s2','e1','2026-09-08T16:00Z','2026-09-08T20:00Z')")


@holds
def test_PRD_P0_18_no_double_booking__back_to_back_shifts_remain_legal():
    p.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at)"
              " VALUES('s3','e1','2026-09-08T17:00Z','2026-09-08T20:00Z')")


@rejects
def test_PRD_P0_18_no_double_booking__moving_a_shift_into_a_conflict_is_refused_on_update():
    p.execute("UPDATE shift SET starts_at='2026-09-08T10:00Z',ends_at='2026-09-08T12:00Z'"
              " WHERE id='s3'")


p.execute("UPDATE shift SET status='cancelled' WHERE id='s1'")


@holds
def test_PRD_P0_18_no_double_booking__a_cancelled_shift_frees_its_slot():
    p.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at)"
              " VALUES('s4','e1','2026-09-08T10:00Z','2026-09-08T12:00Z')")


@rejects
def test_PRD_P0_18_no_double_booking__an_inverted_time_range_is_rejected():
    p.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at)"
              " VALUES('s5','e1','2026-09-09T18:00Z','2026-09-09T09:00Z')")


# ─────────────────────────────────────────────────────────────────────────────
print("\nfinance  (an approved expense is a record, not a row)")
# ─────────────────────────────────────────────────────────────────────────────
f = db('finance')
f.execute("INSERT INTO budget(id,name,period,limit_minor,currency)"
          " VALUES('b1','Marketing','2026-Q3',500000,'USD')")
f.execute("INSERT INTO expense(id,budget_id,employee_id,employee_name,description,amount_minor,"
          "currency,incurred_on) VALUES('x1','b1','e1','Ana','Shoot',120000,'USD','2026-09-01')")


@holds
def test_PRD_P0_20_cross_store_snapshot__an_employee_is_referenced_by_id_plus_a_name_snapshot():
    row = f.execute("SELECT employee_id,employee_name FROM expense WHERE id='x1'").fetchone()
    assert row == ('e1', 'Ana'), f"expected id + snapshot, got {row}"
    for fk in f.execute("PRAGMA foreign_key_list('expense')"):
        assert fk[2] != 'employee', "a cross-database foreign key cannot exist"


@holds
def test_PRD_P0_20_cross_store_snapshot__receipts_are_stored_by_key_never_inline():
    have = set(cols(f, 'expense'))
    assert 'receipt_key' in have, "receipts must live in their own byte store, referenced by key"
    assert not {'receipt_blob', 'receipt_data'} & have, "receipt bytes must not sit in the store"


@holds
def test_PRD_P0_15_money_minor_units__expense_and_budget_amounts_are_integer_minor_units():
    for t in ('expense', 'budget'):
        for r in f.execute(f"PRAGMA table_info('{t}')"):
            name, decl, notnull = r[1], (r[2] or '').upper(), r[3]
            if name.endswith('_minor'):
                assert decl == 'INTEGER', f"{t}.{name} is {decl}, not INTEGER"
            if name == 'currency':
                assert notnull == 1, f"{t}.currency must be NOT NULL"


f.execute("UPDATE expense SET status='approved' WHERE id='x1'")


@rejects
def test_PRD_P0_19_approved_expense_immutable__an_approved_expense_cannot_be_edited_in_place():
    f.execute("UPDATE expense SET amount_minor=1 WHERE id='x1'")


@holds
def test_PRD_P0_19_approved_expense_immutable__an_approved_expense_can_still_progress_state():
    f.execute("UPDATE expense SET status='reimbursed' WHERE id='x1'")


# ─────────────────────────────────────────────────────────────────────────────
print("\naudit  (P0-21: append-only, or it is not an audit log)")
# ─────────────────────────────────────────────────────────────────────────────
a = db('audit')
a.execute("INSERT INTO audit_log(actor,domain,tool,result)"
          " VALUES('ana@vemians.com','finance','expense.approve','ok')")


@rejects
def test_PRD_P0_21_append_only_audit__an_audit_row_cannot_be_updated():
    a.execute("UPDATE audit_log SET result='denied'")


@rejects
def test_PRD_P0_21_append_only_audit__an_audit_row_cannot_be_deleted():
    a.execute("DELETE FROM audit_log")


@rejects
def test_PRD_P0_21_append_only_audit__an_action_in_an_unknown_domain_is_rejected():
    a.execute("INSERT INTO audit_log(actor,domain,tool,result) VALUES('x','payroll','t','ok')")


@holds
def test_PRD_P0_21_append_only_audit__the_actor_is_recorded_and_the_history_stays_intact():
    row = a.execute("SELECT actor,domain,tool FROM audit_log").fetchall()
    assert row == [('ana@vemians.com', 'finance', 'expense.approve')], f"history altered: {row}"


# ─────────────────────────────────────────────────────────────────────────────
print("\ntraceability  (P0-30: no label here that is not a feature in the PRD)")
# ─────────────────────────────────────────────────────────────────────────────

print("\ninventory as a ledger  (P0-31: an agent cannot overwrite a count)")

_inv = db("commerce")
_inv.execute("INSERT INTO location(id,name) VALUES('loc1','Boutique')")


@holds
def test_PRD_P0_31_inventory_ledger__an_adjustment_creates_the_count():
    _inv.execute("INSERT INTO inventory_adjustment(id,sku,location_id,delta,reason,actor)"
                 " VALUES('a1','TEE-M','loc1',12,'receipt','ana@vemians.com')")
    assert _inv.execute("SELECT on_hand FROM inventory_level WHERE sku='TEE-M'").fetchone()[0] == 12


@holds
def test_PRD_P0_31_inventory_ledger__deltas_accumulate():
    _inv.execute("INSERT INTO inventory_adjustment(id,sku,location_id,delta,reason,actor)"
                 " VALUES('a2','TEE-M','loc1',-3,'sale','ana@vemians.com')")
    assert _inv.execute("SELECT on_hand FROM inventory_level WHERE sku='TEE-M'").fetchone()[0] == 9


@rejects
def test_PRD_P0_31_inventory_ledger__the_count_cannot_be_written_directly():
    _inv.execute("UPDATE inventory_level SET on_hand=999 WHERE sku='TEE-M'")


@rejects
def test_PRD_P0_31_inventory_ledger__history_cannot_be_edited():
    _inv.execute("UPDATE inventory_adjustment SET delta=99 WHERE id='a1'")


@rejects
def test_PRD_P0_31_inventory_ledger__history_cannot_be_deleted():
    _inv.execute("DELETE FROM inventory_adjustment WHERE id='a1'")


@rejects
def test_PRD_P0_31_inventory_ledger__a_zero_delta_is_refused():
    _inv.execute("INSERT INTO inventory_adjustment(id,sku,location_id,delta,reason,actor)"
                 " VALUES('a3','TEE-M','loc1',0,'count','x')")


@holds
def test_PRD_P0_31_inventory_ledger__a_mistake_is_undone_by_reversal_not_erasure():
    _inv.execute("INSERT INTO inventory_adjustment(id,sku,location_id,delta,reason,actor,reverses)"
                 " VALUES('a4','TEE-M','loc1',3,'correction','ana@vemians.com','a2')")
    assert _inv.execute("SELECT on_hand FROM inventory_level WHERE sku='TEE-M'").fetchone()[0] == 12
    assert _inv.execute("SELECT count(*) FROM inventory_adjustment").fetchone()[0] == 3


print("\ntickets  (P0-32: closed, never deleted)")

_tk = db("tickets")
_tk.execute("INSERT INTO ticket(id,number,title,category,created_by)"
            " VALUES('t1',1,'Stock mismatch on TEE-M','stock','ana@vemians.com')")
_tk.execute("INSERT INTO ticket_comment(id,ticket_id,author,body)"
            " VALUES('c1','t1','ana@vemians.com','Counted 9, system said 12.')")
_tk.execute("INSERT INTO ticket_link(ticket_id,entity_type,entity_id,label)"
            " VALUES('t1','sku','TEE-M','TEE-M at Boutique')")


@rejects
def test_PRD_P0_32_tickets__a_ticket_cannot_be_deleted_only_closed():
    _tk.execute("DELETE FROM ticket WHERE id='t1'")


@rejects
def test_PRD_P0_32_tickets__comments_cannot_be_edited():
    _tk.execute("UPDATE ticket_comment SET body='never mind' WHERE id='c1'")


@rejects
def test_PRD_P0_32_tickets__comments_cannot_be_deleted():
    _tk.execute("DELETE FROM ticket_comment WHERE id='c1'")


@rejects
def test_PRD_P0_32_tickets__resolving_without_a_timestamp_is_refused():
    _tk.execute("UPDATE ticket SET status='resolved' WHERE id='t1'")


@holds
def test_PRD_P0_32_tickets__resolving_with_a_timestamp_is_allowed():
    _tk.execute("UPDATE ticket SET status='resolved', resolved_at=datetime('now') WHERE id='t1'")


@holds
def test_PRD_P0_32_tickets__links_carry_ids_not_cross_store_foreign_keys():
    sql = (HERE / "tickets.sql").read_text()
    for foreign in ("REFERENCES customer(", "REFERENCES \"order\"(", "REFERENCES employee("):
        assert foreign not in sql, f"tickets.sql has a cross-store FK: {foreign}"


@rejects
def test_PRD_P0_32_tickets__an_unknown_category_is_refused():
    _tk.execute("INSERT INTO ticket(id,number,title,category,created_by)"
                " VALUES('t9',9,'x','payroll','a')")


print("\nworking-set index  (P0-36: read the index, archive the rest, delete nothing)")

_ppl = db("people")
_ppl.execute("INSERT INTO employee(id,email,name) VALUES('e9','rae@vemians.com','Rae')")
_ppl.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at,status)"
             " VALUES('s_past','e9','2026-01-05T09:00Z','2026-01-05T17:00Z','completed')")
_ppl.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at,status)"
             " VALUES('s_future','e9','2027-01-05T09:00Z','2027-01-05T17:00Z','scheduled')")


@holds
def test_PRD_P0_36_working_set_index__the_index_starts_as_everything_unarchived():
    assert _ppl.execute("SELECT count(*) FROM shift_index").fetchone()[0] == 2


@rejects
def test_PRD_P0_36_working_set_index__a_future_shift_cannot_be_rolled_off():
    _ppl.execute("UPDATE shift SET archived_at=datetime('now') WHERE id='s_future'")


@holds
def test_PRD_P0_36_working_set_index__a_settled_past_shift_rolls_off_the_index():
    _ppl.execute("UPDATE shift SET archived_at=datetime('now') WHERE id='s_past'")
    assert _ppl.execute("SELECT count(*) FROM shift_index").fetchone()[0] == 1


@holds
def test_PRD_P0_36_working_set_index__rolled_off_data_is_still_there():
    assert _ppl.execute("SELECT count(*) FROM shift").fetchone()[0] == 2
    assert _ppl.execute("SELECT status FROM shift WHERE id='s_past'").fetchone()[0] == "completed"


@rejects
def test_PRD_P0_36_working_set_index__a_shift_cannot_be_deleted():
    _ppl.execute("DELETE FROM shift WHERE id='s_past'")


_tkx = db("tickets")
_tkx.execute("INSERT INTO ticket(id,number,title,created_by) VALUES('tx1',1,'Open thing','a@vemians.com')")


@rejects
def test_PRD_P0_36_working_set_index__an_open_ticket_cannot_be_rolled_off():
    _tkx.execute("UPDATE ticket SET archived_at=datetime('now') WHERE id='tx1'")


@holds
def test_PRD_P0_36_working_set_index__a_closed_ticket_rolls_off_but_survives():
    _tkx.execute("UPDATE ticket SET status='closed', resolved_at=datetime('now') WHERE id='tx1'")
    _tkx.execute("UPDATE ticket SET archived_at=datetime('now') WHERE id='tx1'")
    assert _tkx.execute("SELECT count(*) FROM ticket_index").fetchone()[0] == 0
    assert _tkx.execute("SELECT count(*) FROM ticket").fetchone()[0] == 1


@holds
def test_PRD_P0_30_prd_traceability__every_label_used_here_exists_in_the_prd():
    assert PRD.exists(), f"{PRD} not found: PRD-backed checks cannot be traced"
    text = PRD.read_text()
    missing = [label for label in labels if label not in text]
    assert not missing, f"labels absent from docs/PRD.md: {missing}"


print(f"\n{total} checks across {len(labels)} PRD features — "
      + ("ALL CHECKS PASSED" if ok else "FAILURES ABOVE"))
sys.exit(0 if ok else 1)
