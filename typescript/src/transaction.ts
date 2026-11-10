/**
 * Turns as transactions: all of a turn's changes, or none of them.
 *
 * The semantics are snapshot isolation over files, with the first committer
 * winning at path granularity:
 *
 * 1. Begin. Checkpoint each disk the turn may write and branch from it. The
 *    branch is the turn's private workspace; reads inside the turn see a
 *    consistent snapshot plus the turn's own writes.
 * 2. Work. Every verb on the turn's context (`sh`, `sql`, `write` …) acts
 *    on the branch. Nothing the turn does is visible to anyone else.
 * 3. Commit. Find what the turn changed (a metadata comparison of the branch
 *    against its starting point). If none of those paths changed on the main line
 *    in the meantime (the main line now, against a listing of it taken at the
 *    start), copy them across in one call. If any did, throw `Conflict` naming
 *    them, and apply nothing.
 *
 * With `isolation: "serializable"` the commit also fails if anything under the
 * declared `reads` changed on the main line, which protects decisions that were
 * based on data the turn did not write.
 *
 * Archil provides the two expensive parts natively: checkpoints and branches are
 * copy-on-write and take milliseconds at any size. It does not yet merge a branch
 * back, so this module does the validation and the copy itself. That is the part
 * that belongs in the storage layer.
 */

import { randomUUID } from "node:crypto";

import { MountSpec, Vm } from "./backends.ts";
import { sorted, strip, tail } from "./compat.ts";
import { META } from "./context.ts";
import type { Context, Mount } from "./context.ts";
import { ArchilError, Conflict, NotSupported, ValidationError } from "./errors.ts";
import { estimate } from "./pricing.ts";

export class Commit {
  readonly id: string;
  /** context paths written to the main line */
  applied: string[] = [];
  deleted: string[] = [];
  calls = 0;

  constructor(id: string) {
    this.id = id;
  }

  get empty(): boolean {
    return !(this.applied.length || this.deleted.length);
  }
}

export interface TransactionOptions {
  /** the paths the turn may write; left out, every writable mount */
  writes?: string[] | null;
  /** the paths the turn's decisions depend on: checked at commit under serializable isolation */
  reads?: string[] | null;
  isolation?: "snapshot" | "serializable";
  name?: string | null;
}

export type TransactionState = "new" | "open" | "committed" | "aborted" | "rolled_back" | "failed";

/** rel -> size and version, as one string: a listing is only ever compared */
type Listing = Map<string, string>;

export class Transaction {
  readonly base: Context;
  readonly id: string;
  readonly isolation: "snapshot" | "serializable";
  state: TransactionState = "new";
  readonly writeRoots = new Map<string, string[]>();
  readonly readRoots = new Map<string, string[]>();
  #view: Context | null = null; // the context the turn works in
  #branches = new Map<string, string>();
  #start = new Map<string, Listing>(); // each branch, at the start
  #mainStart = new Map<string, Listing>(); // the same listing of the main line, taken first
  #readStart = new Map<string, Listing>();
  #newest = 0; // the latest modification time in the listings taken so far

  constructor(ctx: Context, options: TransactionOptions = {}) {
    const isolation = options.isolation ?? "snapshot";
    if (isolation !== "snapshot" && isolation !== "serializable") {
      throw new ValidationError(`unknown isolation '${isolation}'`, {
        code: "bad_isolation",
        suggestion: "use 'snapshot' or 'serializable'",
      });
    }
    const missing = ["branch", "checkpoint"].filter((c) => !ctx.backend.capabilities.has(c));
    if (missing.length) {
      throw new NotSupported(`${ctx.backend.name} cannot run transactions: it lacks ${missing.join(", ")}`, {
        suggestion: "transactions need a disk that can checkpoint and branch (an Archil-managed disk)",
      });
    }
    this.base = ctx;
    this.id = options.name || `tx-${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    this.isolation = isolation;

    const add = (roots: Map<string, string[]>, mount: string, rel: string): void => {
      if (!roots.has(mount)) roots.set(mount, []);
      roots.get(mount)!.push(rel);
    };
    if (options.writes?.length) {
      for (const p of options.writes) {
        const [m, rel] = ctx._resolve(p, { write: true });
        add(this.writeRoots, m.name, rel);
      }
    } else {
      for (const m of ctx.mounts.values()) if (m.writable) add(this.writeRoots, m.name, m.allow);
    }
    if (!this.writeRoots.size) {
      throw new ValidationError("this context has nothing a transaction could write", {
        code: "read_only",
        suggestion: "mount at least one disk as 'owned' or 'shared'",
      });
    }
    for (const p of options.reads ?? []) {
      const [m, rel] = ctx._resolve(p);
      add(this.readRoots, m.name, rel);
    }
    if (isolation === "serializable" && !this.readRoots.size) {
      throw new ValidationError("serializable isolation needs reads: [...]", {
        code: "bad_isolation",
        suggestion: "list the paths this turn's decisions depend on",
      });
    }
  }

  /** The context the turn works in: the same paths, on the turn's branch. */
  get ctx(): Context {
    if (this.#view === null) {
      throw new ArchilError(`transaction ${this.id} is not open`, {
        code: "bad_state",
        suggestion: "call begin() first, or use ctx.transaction(fn)",
      });
    }
    return this.#view;
  }

  // -- lifecycle ---------------------------------------------------------------
  async begin(): Promise<this> {
    if (this.state !== "new") {
      throw new ArchilError(`transaction ${this.id} is already ${this.state}`, { code: "bad_state" });
    }
    const ctx = this.base;
    const backend = ctx.backend;
    const mounts = new Map(ctx.mounts);
    // List the main line first, then checkpoint. A write that lands in between is in the turn's
    // snapshot but not in this listing, so the commit reports it as a conflict: a needless abort
    // at worst, never a lost update.
    for (const [name, roots] of this.writeRoots) {
      const m = ctx.mounts.get(name)!;
      this.#mainStart.set(name, await this.#listing(m.handle, m, roots));
    }
    for (const [name, roots] of this.readRoots) {
      const m = ctx.mounts.get(name)!;
      this.#readStart.set(name, await this.#listing(m.handle, m, roots));
    }
    // Where versions are coarse (Archil: whole seconds), a file written a moment ago could be
    // rewritten again, by anyone, without its version moving, and the commit would not see it.
    // So the snapshot is not taken until the newest file listed is older than that. Usually no wait.
    await ctx._settle(this.#newest);
    for (const [name, roots] of this.writeRoots) {
      const m = ctx.mounts.get(name)!;
      const checkpoint = await ctx._checkpoint(m.handle, `${this.id}-base`);
      const branch = await backend.branch(m.handle, this.id, checkpoint);
      this.#branches.set(name, branch);
      mounts.set(name, m.with({ handle: branch }));
      // the whole branch, not only the declared paths: a write the turn did not declare
      // has to be noticed at commit, not dropped
      this.#start.set(name, await this.#listing(branch, m, [m.allow]));
    }
    await ctx._settle(this.#newest); // and the turn's own writes must not share a second with what it started from
    this.#view = ctx._derive(mounts, { name: `${ctx.name}#${this.id}` });
    this.state = "open";
    return this;
  }

  async #listing(handle: string, m: Mount, roots: string[]): Promise<Listing> {
    const out: Listing = new Map();
    for (const root of roots) {
      for (const o of await this.base.backend.list(handle, m.key(root), { recursive: true })) {
        const rel = m.rel(o.key);
        if (rel.startsWith(META + "/")) continue;
        if (!root || rel === root || rel.startsWith(root + "/")) {
          out.set(rel, `${o.size}:${o.version}`);
          this.#newest = Math.max(this.#newest, o.modified);
        }
      }
    }
    return out;
  }

  /** What the turn has changed so far, by mount. A metadata comparison. */
  async changes(): Promise<Map<string, { written: string[]; deleted: string[] }>> {
    this.#requireOpen();
    const out = new Map<string, { written: string[]; deleted: string[] }>();
    for (const [name, branch] of this.#branches) {
      const m = this.base.mounts.get(name)!;
      const now = await this.#listing(branch, m, [m.allow]);
      const start = this.#start.get(name)!;
      const written = sorted([...now].filter(([rel, meta]) => start.get(rel) !== meta).map(([rel]) => rel));
      const deleted = sorted([...start.keys()].filter((rel) => !now.has(rel)));
      if (written.length || deleted.length) out.set(name, { written, deleted });
    }
    return out;
  }

  async commit(): Promise<Commit> {
    this.#requireOpen();
    const ctx = this.base;
    const backend = ctx.backend;
    const changes = await this.changes();
    const undeclared: string[] = [];
    for (const [name, { written, deleted }] of changes) {
      const roots = this.writeRoots.get(name)!;
      for (const rel of [...written, ...deleted]) {
        if (!roots.some((root) => !root || rel === root || rel.startsWith(root + "/"))) undeclared.push(`${name}/${rel}`);
      }
    }
    if (undeclared.length) {
      this.state = "aborted";
      const shown = sorted(undeclared);
      throw new ValidationError(
        "the turn changed paths it did not declare: " + shown.slice(0, 5).join(", ") + (shown.length > 5 ? " …" : ""),
        {
          code: "undeclared_write",
          suggestion: "add them to writes: [...], or leave writes out to cover every writable mount",
        },
      );
    }
    const result = new Commit(this.id);
    const releases: (() => void)[] = [];
    try {
      for (const name of sorted(changes.keys())) releases.push(await backend.commitLock(ctx.mounts.get(name)!.handle));
      this.#requireOpen(); // a second commit() of this transaction may have run while this one waited
      // validate every mount before applying to any
      const conflicts: string[] = [];
      for (const [name, { written, deleted }] of changes) {
        const m = ctx.mounts.get(name)!;
        const main = await this.#listing(m.handle, m, this.writeRoots.get(name)!);
        const start = this.#mainStart.get(name)!;
        for (const rel of [...written, ...deleted]) {
          if (main.get(rel) !== start.get(rel)) conflicts.push(`${name}/${rel}`);
        }
      }
      if (this.isolation === "serializable") {
        for (const [name, roots] of this.readRoots) {
          const m = ctx.mounts.get(name)!;
          const main = await this.#listing(m.handle, m, roots);
          const start = this.#readStart.get(name)!;
          const mine = changes.get(name);
          const own = new Set([...(mine?.written ?? []), ...(mine?.deleted ?? [])]);
          for (const rel of sorted(new Set([...main.keys(), ...start.keys()]))) {
            if (main.get(rel) !== start.get(rel) && !own.has(rel)) conflicts.push(`${name}/${rel}`);
          }
        }
      }
      if (conflicts.length) {
        this.state = "aborted";
        throw new Conflict(sorted(new Set(conflicts)));
      }
      for (const [name, { written, deleted }] of changes) {
        await this.#apply(name, written, deleted);
        for (const rel of written) result.applied.push(`${name}/${rel}`);
        for (const rel of deleted) result.deleted.push(`${name}/${rel}`);
        result.calls += 1;
      }
    } finally {
      for (const release of releases.reverse()) release();
    }
    this.state = "committed";
    ctx.spend.add(estimate(ctx.prices, { calls: result.calls }), { statement: false });
    await ctx._record({
      kind: "commit",
      tx: this.id,
      applied: result.applied.length,
      deleted: result.deleted.length,
      calls: result.calls,
    });
    return result;
  }

  /** Copy the turn's changes from the branch to the main line, in one call next to the data. */
  async #apply(name: string, written: string[], deleted: string[]): Promise<void> {
    const backend = this.base.backend;
    const m = this.base.mounts.get(name)!;
    const branch = this.#branches.get(name)!;
    const manifest = written.map((rel) => `W\t${rel}\n`).join("") + deleted.map((rel) => `D\t${rel}\n`).join("");
    const manifestRel = `${META}/tx/${this.id}.changes`;
    await backend.put(branch, m.key(manifestRel), Buffer.from(manifest));
    const subdirectory = m.source.subdirectory || null;
    // An owned mount commits under its checkout, so no other writer can interleave.
    // A shared mount has no checkout to take; its commit is optimistic.
    const dst =
      m.mode === "shared"
        ? new MountSpec(m.handle, { subdirectory, conditional: true })
        : new MountSpec(m.handle, { subdirectory, queueMs: backend.limits.checkoutQueueMs });
    const script =
      [
        "set -e",
        `while IFS="$(printf '\\t')" read -r op rel; do`,
        '  if [ "$op" = "D" ]; then rm -f "dst/$rel"',
        '  else mkdir -p "$(dirname "dst/$rel")"; cp -p "src/$rel" "dst/$rel.px-tmp"; mv -f "dst/$rel.px-tmp" "dst/$rel"; fi',
        `done < "src/${manifestRel}"`,
      ].join("\n") + "\n";
    const out = await backend.exec({ src: new MountSpec(branch, { subdirectory, readOnly: true }), dst }, script, new Vm());
    if (out.exitCode !== 0) {
      this.state = "failed";
      throw new ArchilError(`commit of ${this.id} failed while applying to '${name}': ${tail(strip(out.stderr), 300)}`, {
        code: "commit_failed",
        suggestion: "some paths may have been applied; the branch still holds the full turn",
      });
    }
  }

  /** Abandon the turn. Nothing was ever written to the main line, so there is nothing to undo. */
  async rollback(): Promise<void> {
    if (this.state === "open") {
      this.state = "rolled_back";
      await this.base._record({ kind: "rollback", tx: this.id });
    }
  }

  #requireOpen(): void {
    if (this.state !== "open") {
      throw new ArchilError(`transaction ${this.id} is ${this.state}, not open`, {
        code: "bad_state",
        suggestion: "call begin(), or use ctx.transaction(fn)",
      });
    }
  }

  toString(): string {
    return `<Transaction ${this.id} ${this.state}>`;
  }
}
