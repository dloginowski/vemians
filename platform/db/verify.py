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
