/**
 * Errors an agent can act on.
 *
 * Every error carries a stable `code`, a plain-language `message`, the `path` it
 * concerns when there is one, and a `suggestion` that says what to do next.
 * Validation runs before anything is sent to Archil, and reports every problem
 * it finds at once so a caller can fix them in a single turn.
 */

import { splitlines, strip } from "./compat.ts";

export interface Issue {
  code: string;
  message: string;
  path?: string | null;
  suggestion?: string | null;
}

/** An issue as one line: `code [path]: message — suggestion`. */
export function issueText(issue: Issue): string {
  const where = issue.path ? ` [${issue.path}]` : "";
  const hint = issue.suggestion ? ` — ${issue.suggestion}` : "";
  return `${issue.code}${where}: ${issue.message}${hint}`;
}

function plain(issue: Issue): Required<Issue> {
  return { code: issue.code, message: issue.message, path: issue.path ?? null, suggestion: issue.suggestion ?? null };
}

export interface ErrorDetails {
  path?: string | null;
  suggestion?: string | null;
  code?: string;
}

/**
 * Base class (the Python SDK calls it `Error`). `message` is the plain message;
 * `String(error)` adds the code, the path and the suggestion, and is safe to show to a model.
 */
export class ArchilError extends Error {
  static readonly code: string = "error";
  static {
    this.prototype.name = "ArchilError";
  }

  code: string;
  path: string | null;
  suggestion: string | null;

  constructor(message: string, details: ErrorDetails = {}) {
    super(message);
    this.code = details.code || (this.constructor as typeof ArchilError).code;
    this.path = details.path ?? null;
    this.suggestion = details.suggestion ?? null;
  }

  override toString(): string {
    return issueText(this);
  }

  toJSON(): object {
    return plain(this);
  }
}

/** The request is wrong and nothing ran. `issues` lists every problem. */
export class ValidationError extends ArchilError {
  static override readonly code: string = "invalid";
  static {
    this.prototype.name = "ValidationError";
  }

  issues: Issue[];

  constructor(issues: Issue[] | string, details: ErrorDetails = {}) {
    const list =
      typeof issues === "string"
        ? [{ code: details.code || "invalid", message: issues, path: details.path, suggestion: details.suggestion }]
        : [...issues];
    const first = list[0];
    super(first.message, { path: first.path, suggestion: first.suggestion, code: first.code });
    this.issues = list;
  }

  override toString(): string {
    return this.issues.map(issueText).join("\n");
  }

  override toJSON(): object {
    return { code: this.code, issues: this.issues.map(plain) };
  }
}

/** The plan costs more than the budget allows. Nothing ran. */
export class BudgetExceeded extends ArchilError {
  static override readonly code: string = "budget_exceeded";
  static {
    this.prototype.name = "BudgetExceeded";
  }
}

/** A transaction could not commit because someone else changed the same paths. */
export class Conflict extends ArchilError {
  static override readonly code: string = "conflict";
  static {
    this.prototype.name = "Conflict";
  }

  paths: string[];

  constructor(paths: string[], message?: string) {
    const list = [...paths];
    const shown = list.slice(0, 5).join(", ") + (list.length > 5 ? " …" : "");
    super(message || `${list.length} path(s) changed since this transaction began: ${shown}`, {
      path: list.length ? list[0] : null,
      suggestion: "re-run the turn on a fresh transaction; nothing was applied",
    });
    this.paths = list;
  }
}

/**
 * Another client holds a checkout that covers this path, so it cannot be written right now.
 *
 * On Archil a statement that writes an `owned` mount holds the mount's checkout while it runs.
 * Until it finishes, direct writes to that disk (`write`, `append`, `rm`) are refused.
 */
export class Busy extends ArchilError {
  static override readonly code: string = "busy";
  static {
    this.prototype.name = "Busy";
  }
}

/** The backend cannot do this (yet). The message says what is missing. */
export class NotSupported extends ArchilError {
  static override readonly code: string = "not_supported";
  static {
    this.prototype.name = "NotSupported";
  }
}

/** A command exited non-zero and the caller asked for that to throw. */
export class ExecFailed extends ArchilError {
  static override readonly code: string = "exec_failed";
  static {
    this.prototype.name = "ExecFailed";
  }

  exitCode: number;
  stderr: string;
  command: string;

  constructor(exitCode: number, stderr: string, command: string) {
    const text = strip(stderr);
    const tail = text ? splitlines(text).at(-1)! : "no stderr";
    super(`exit ${exitCode}: ${tail}`, { suggestion: "read result.stderr for the full output" });
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.command = command;
  }
}
