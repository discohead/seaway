---
type: llm
weight: 3
---

            PASS only if all of these hold:
            - both changes are made inside one seaway transaction: `with ctx.transaction(...) as turn:` (or the explicit `begin()` / `commit()` form);
            - every write inside it goes through the turn (`turn.write`, `turn.sh(... turn.out(...))`, `turn.append`), not through the outer `ctx`;
            - `archil.Conflict` is caught, and the response to it is to run the whole turn again from the new state, a bounded number of times;
            - if `writes=` is given, it names both `team` and `memory` (or paths on both). Leaving `writes` out is also right.

            FAIL if a write inside the turn goes through `ctx` instead of `turn`. FAIL if `writes=` names only one of the two disks: a write to the other would then land at once, outside the turn. FAIL if a conflict is not handled, or is handled by writing the stale content again without redoing the turn. FAIL if the answer uses file locks, or invents an API such as `ctx.lock_file` or `ctx.atomic`.
