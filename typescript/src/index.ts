/**
 * The programmable Archil: define the context an agent needs, then run statements against it.
 *
 *     import * as archil from "seaway";
 *
 *     const ctx = await archil.context({
 *       logs: archil.disk("app-logs", "append"),
 *       obs: archil.disk("obs-agent", "owned"),
 *     });
 *
 *     const q = ctx.sql`select level, count(*) as n from ${ctx.log("logs/api").last("15m")} group by 1`;
 *     console.log(String(await q.explain())); // what it mounts, how many calls, what it costs
 *     const { rows } = await q;               // runs next to the data; only the rows come back
 *
 * This is a prototype of a proposal, packaged under its own name so it installs
 * beside the official `disk` package, which it uses to reach Archil.
 */

import { Context } from "./context.ts";
import type { ContextOptions } from "./context.ts";

export { MountSpec, Vm, Limits, ObjectInfo, TRUNCATED_MARK, egressPolicy } from "./backends.ts";
export type {
  Backend,
  Egress,
  ExecOutput,
  GrepHit,
  GrepOptions,
  MountSpecJSON,
  MountSpecOptions,
  VmJSON,
  VmOptions,
} from "./backends.ts";
export { MODES, Context, Mount, Source, context, disk } from "./context.ts";
export type { ContextOptions, Manifest, Mode, MountManifest, SourceOptions } from "./context.ts";
export { ArchilError, BudgetExceeded, Busy, Conflict, ExecFailed, NotSupported, ValidationError, issueText } from "./errors.ts";
export type { ErrorDetails, Issue } from "./errors.ts";
export { LocalBackend } from "./local.ts";
export type { LocalBackendOptions } from "./local.ts";
export { ArchilBackend } from "./archil-backend.ts";
export type { ArchilBackendOptions, ArchilClient, ArchilDisk } from "./archil-backend.ts";
export { Plan, Task } from "./plan.ts";
export { Budget, Estimate, Ledger, PriceSheet, estimate, fmtBytes, fmtUsd } from "./pricing.ts";
export type { BudgetLimits, Prices } from "./pricing.ts";
export { DUCKDB_SHA256, DUCKDB_VERSION, Records, Static, duckdb, git, sync } from "./recipes.ts";
export type { Entry, Recipe, RecordsOptions, SyncStats } from "./recipes.ts";
export { FileStat, Glob, Raw, Ref, raw } from "./shell.ts";
export type { Selectable } from "./shell.ts";
export { REDUCERS, Meta, Result, Statement } from "./statement.ts";
export type { Reduce, ReducerName, Row } from "./statement.ts";
export { Changes, Feed, Log, Selection, View } from "./structures.ts";
export type { LogOptions, ViewInput } from "./structures.ts";
export { Tool, asFileSystem } from "./tools.ts";
export type { ContextFileSystem, ToolSchema } from "./tools.ts";
export { Commit, Transaction } from "./transaction.ts";
export type { TransactionOptions, TransactionState } from "./transaction.ts";

export const VERSION = "0.1.0";

/** Open a context from a manifest (an object, a JSON string, or a path to a file). */
export function fromManifest(
  manifest: object | string,
  options: Pick<ContextOptions, "backend" | "prices" | "budget"> = {},
): Promise<Context> {
  return Context.fromManifest(manifest, options);
}
