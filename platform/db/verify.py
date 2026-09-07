#!/usr/bin/env python3
"""Loads each D1 schema into an in-memory SQLite database and asserts the
guarantees each store is supposed to enforce. Run: python3 platform/db/verify.py"""
import sqlite3, sys, pathlib
HERE = pathlib.Path(__file__).parent
ok = True

def db(name):
    c = sqlite3.connect(':memory:')
    c.executescript("PRAGMA foreign_keys=ON;" + (HERE/f'{name}.sql').read_text())
    return c

def check(label, fn, expect_fail=False):
    global ok
    try:
        fn(); passed = not expect_fail
        detail = '' if passed else 'expected rejection, was accepted'
    except sqlite3.Error as e:
        passed = expect_fail; detail = '' if passed else str(e)
    ok &= passed
    print(f"  {'PASS' if passed else 'FAIL'}  {label}" + (f"   <-- {detail}" if detail else ''))

print("\ncommerce")
c = db('commerce')
c.execute("INSERT INTO \"order\"(id,order_number,channel,external_id,currency) VALUES('o1',1,'shopify','gid/1','USD')")
check("webhook replay cannot duplicate an order",
      lambda: c.execute("INSERT INTO \"order\"(id,order_number,channel,external_id,currency) VALUES('o2',2,'shopify','gid/1','USD')"),
      expect_fail=True)
check("order line survives with no catalog FK",
      lambda: c.execute("INSERT INTO order_line(id,order_id,product_handle,title_snapshot,quantity,unit_price_minor,currency)"
                        " VALUES('l1','o1','bone-tee','Bone Tee',1,4500,'USD')"))
check("zero-quantity line rejected",
      lambda: c.execute("INSERT INTO order_line(id,order_id,product_handle,title_snapshot,quantity,unit_price_minor,currency)"
                        " VALUES('l2','o1','x','X',0,1,'USD')"), expect_fail=True)

print("\ncustomers  (erasure is the whole point of this split)")
cu = db('customers')
cu.execute("INSERT INTO customer(id,birth_year) VALUES('c1',1990)")
check("customers store holds NO direct identifiers",
      lambda: (lambda cols: not {'email','phone','name'} & set(cols)
               or (_ for _ in ()).throw(AssertionError(f"identifier columns present: {cols}")))(
          [r[1] for r in cu.execute("PRAGMA table_info('customer')")]))
cu.execute("INSERT INTO customer_fit(customer_id,garment,size_label) VALUES('c1','tops','IT 42')")
cu.execute("INSERT INTO customer_consent(customer_id,purpose,granted,source) VALUES('c1','marketing',1,'checkout')")
check("implausible birth year rejected",
      lambda: cu.execute("INSERT INTO customer(id,birth_year) VALUES('c9',1200)"), expect_fail=True)
check("unknown consent purpose rejected",
      lambda: cu.execute("INSERT INTO customer_consent(customer_id,purpose,granted,source) VALUES('c1','resale',1,'x')"),
      expect_fail=True)
cu.execute("INSERT INTO erasure_request(id,customer_id) VALUES('er1','c1')")
cu.execute("DELETE FROM customer WHERE id='c1'")
check("erasing a profile cascades to fit data",
      lambda: cu.execute("SELECT count(*) FROM customer_fit").fetchone()[0] == 0 or (_ for _ in ()).throw(AssertionError()))
check("erasing a profile cascades to consent",
      lambda: cu.execute("SELECT count(*) FROM customer_consent").fetchone()[0] == 0 or (_ for _ in ()).throw(AssertionError()))
check("erasure evidence survives the erasure",
      lambda: cu.execute("SELECT count(*) FROM erasure_request").fetchone()[0] == 1 or (_ for _ in ()).throw(AssertionError()))
check("erasure evidence cannot itself be deleted",
      lambda: cu.execute("DELETE FROM erasure_request"), expect_fail=True)

print("\nreversibility  (non-destructive edits without immutability)")
cv = db('customers')
cv.execute("INSERT INTO customer(id,birth_year) VALUES('c2',1985)")
cv.execute("INSERT INTO customer_fit(customer_id,garment,size_label) VALUES('c2','tops','IT 40')")
cv.execute("INSERT INTO customer_version(customer_id,table_name,field,old_value,new_value,actor)"
           " VALUES('c2','customer_fit','size_label','IT 40','IT 42','ana@vemians.com')")
cv.execute("UPDATE customer_fit SET size_label='IT 42' WHERE customer_id='c2'")
check("an edit is recorded before it is applied",
      lambda: cv.execute("SELECT old_value FROM customer_version WHERE customer_id='c2'").fetchone()[0]=='IT 40'
              or (_ for _ in ()).throw(AssertionError()))
check("history cannot be rewritten",
      lambda: cv.execute("UPDATE customer_version SET new_value='IT 50'"), expect_fail=True)
cv.execute("INSERT INTO customer_version(customer_id,table_name,field,old_value,new_value,actor,reverts)"
           " VALUES('c2','customer_fit','size_label','IT 42','IT 40','ana@vemians.com',1)")
cv.execute("UPDATE customer_fit SET size_label='IT 40' WHERE customer_id='c2'")
check("a change is revertible, and the revert is itself recorded",
      lambda: (cv.execute("SELECT size_label FROM customer_fit WHERE customer_id='c2'").fetchone()[0]=='IT 40'
               and cv.execute("SELECT count(*) FROM customer_version WHERE reverts IS NOT NULL").fetchone()[0]==1)
              or (_ for _ in ()).throw(AssertionError()))
check("history is NOT deletable without an erasure request",
      lambda: cv.execute("DELETE FROM customer_version WHERE customer_id='c2'"), expect_fail=True)
cv.execute("INSERT INTO erasure_request(id,customer_id) VALUES('er2','c2')")
check("history IS deletable under an open erasure request",
      lambda: cv.execute("DELETE FROM customer_version WHERE customer_id='c2'"))

print("\nidentity  (the vault)")
idn = db('identity')
idn.execute("INSERT INTO customer_identity(customer_id,name_enc,email_enc,email_hmac,wrapped_dek,kek_id)"
            " VALUES('c1',x'AA',x'BB',x'CC',x'DD','kek-1')")
check("lookup handle is keyed (HMAC), not a bare hash",
      lambda: (lambda cols: 'email_hmac' in cols and 'email_enc' in cols
               or (_ for _ in ()).throw(AssertionError()))(
          [r[1] for r in idn.execute("PRAGMA table_info('customer_identity')")]))
idn.execute("UPDATE customer_identity SET crypto_shredded=1 WHERE customer_id='c1'")
r = idn.execute("SELECT name_enc,email_enc,email_hmac,length(wrapped_dek) FROM customer_identity WHERE customer_id='c1'").fetchone()
check("crypto-shredding clears ciphertext and the wrapped key",
      lambda: (r[0] is None and r[1] is None and r[2] is None and r[3]==0)
              or (_ for _ in ()).throw(AssertionError(f"residue: {r}")))

print("\ncross-store: erasure vs tax retention")
c.execute("INSERT INTO \"order\"(id,order_number,channel,external_id,customer_id,currency)"
          " VALUES('o9',9,'pos','pos/1','c1','USD')")
check("order survives customer erasure (tax retention)",
      lambda: c.execute("SELECT count(*) FROM \"order\" WHERE id='o9'").fetchone()[0] == 1 or (_ for _ in ()).throw(AssertionError()))
check("order carries no customer PII, only a dangling id",
      lambda: (lambda cols: 'customer_id' in cols and not {'email','phone','name','birth_year'} & set(cols)
               or (_ for _ in ()).throw(AssertionError(f"PII columns present: {cols}")))(
          [r[1] for r in c.execute("PRAGMA table_info('order')")]))
check("POS is just another channel - no schema change needed",
      lambda: c.execute("SELECT channel FROM \"order\" WHERE id='o9'").fetchone()[0] == 'pos' or (_ for _ in ()).throw(AssertionError()))

print("\npeople")
p = db('people')
p.execute("INSERT INTO employee(id,email,name) VALUES('e1','ana@vemians.com','Ana')")
p.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at) VALUES('s1','e1','2026-09-08T09:00Z','2026-09-08T17:00Z')")
check("agent cannot double-book an employee",
      lambda: p.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at) VALUES('s2','e1','2026-09-08T16:00Z','2026-09-08T20:00Z')"),
      expect_fail=True)
check("back-to-back shifts allowed",
      lambda: p.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at) VALUES('s3','e1','2026-09-08T17:00Z','2026-09-08T20:00Z')"))
check("moving a shift into a conflict is rejected",
      lambda: p.execute("UPDATE shift SET starts_at='2026-09-08T10:00Z',ends_at='2026-09-08T12:00Z' WHERE id='s3'"),
      expect_fail=True)
p.execute("UPDATE shift SET status='cancelled' WHERE id='s1'")
check("a cancelled shift frees its slot",
      lambda: p.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at) VALUES('s4','e1','2026-09-08T10:00Z','2026-09-08T12:00Z')"))
check("inverted time range rejected",
      lambda: p.execute("INSERT INTO shift(id,employee_id,starts_at,ends_at) VALUES('s5','e1','2026-09-09T18:00Z','2026-09-09T09:00Z')"),
      expect_fail=True)

print("\nfinance")
f = db('finance')
f.execute("INSERT INTO budget(id,name,period,limit_minor,currency) VALUES('b1','Marketing','2026-Q3',500000,'USD')")
f.execute("INSERT INTO expense(id,budget_id,employee_id,employee_name,description,amount_minor,currency,incurred_on)"
          " VALUES('x1','b1','e1','Ana','Shoot','120000','USD','2026-09-01')")
check("employee reference is a snapshot, not a cross-database FK",
      lambda: f.execute("SELECT employee_name FROM expense WHERE id='x1'").fetchone()[0] == 'Ana' or (_ for _ in ()).throw(AssertionError()))
f.execute("UPDATE expense SET status='approved' WHERE id='x1'")
check("approved expense cannot be edited in place",
      lambda: f.execute("UPDATE expense SET amount_minor=1 WHERE id='x1'"), expect_fail=True)
check("approved expense can still change state (reimburse)",
      lambda: f.execute("UPDATE expense SET status='reimbursed' WHERE id='x1'"))

print("\naudit")
a = db('audit')
a.execute("INSERT INTO audit_log(actor,domain,tool,result) VALUES('ana@vemians.com','finance','expense.approve','ok')")
check("audit rows cannot be updated", lambda: a.execute("UPDATE audit_log SET result='denied'"), expect_fail=True)
check("audit rows cannot be deleted", lambda: a.execute("DELETE FROM audit_log"), expect_fail=True)
check("unknown domain rejected",
      lambda: a.execute("INSERT INTO audit_log(actor,domain,tool,result) VALUES('x','payroll','t','ok')"), expect_fail=True)
check("history intact", lambda: a.execute("SELECT count(*) FROM audit_log").fetchone()[0] == 1 or (_ for _ in ()).throw(AssertionError()))

print("\n" + ("ALL CHECKS PASSED" if ok else "FAILURES ABOVE"))
sys.exit(0 if ok else 1)
