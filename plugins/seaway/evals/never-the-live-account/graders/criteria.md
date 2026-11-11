---
type: llm
weight: 3
---

            PASS only if all of these hold:
            - the test passes a backend explicitly: `archil.LocalBackend(...)` rooted in a temporary directory (pytest's `tmp_path`, or `tempfile`), given as `backend=` to `archil.context(...)`;
            - the disk is created for the test (`create=True`, or by writing files under the root's `disks/<name>/`), and the Markdown files are seeded, through a context that can write them or through the backend;
            - the answer explains that with no `backend` argument a context uses Archil whenever `ARCHIL_API_KEY` is set, so the test would run against the live account, create or read real disks, and bill.

            Setting `ARCHIL_BACKEND=local` with `monkeypatch` is acceptable as an extra, and acceptable alone only if the root is also pointed at a temporary directory (`ARCHIL_LOCAL_ROOT`).

            FAIL if the test opens a context with no backend and no environment override. FAIL if it mocks seaway itself instead of running the statement on the local backend. FAIL if it writes into `.archil-local` in the project instead of a temporary directory.
