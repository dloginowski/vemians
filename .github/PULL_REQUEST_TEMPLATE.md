### What changed

<!-- One or two sentences. What is different after this merges? -->

### Why

<!-- The problem, not the patch. If this reverses an earlier decision, say which and why. -->

### Decision log

<!-- Only for choices a reader would otherwise have to reconstruct. Delete if none. -->

| # | Decision | Alternatives | Rationale | Downsides |
|---|---|---|---|---|
| 1 |   |   |   |   |

### PRD

<!-- Behaviour changes move the PRD feature and its labelled test in the SAME change (RULES.md
     rule 13). Name the Test-PRD-* features touched, or state the non-behavioural reason. -->

- Features:
- Non-behavioural bypass reason:

### Verification

<!-- What you RAN, with the result. Not what you intend to run. A syntax check is not
     sufficient — exercise the real path. -->

- [ ] `python3 shared/db/verify.py`
- [ ] `npm test` in `ops/`
- [ ] `wrangler dev` on the affected surface, with the behaviour actually exercised
- [ ] Storefront still carries zero D1 bindings

### Risk

<!-- What breaks if this is wrong, and how it would be noticed. -->
