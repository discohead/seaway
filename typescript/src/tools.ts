/**
 * A context as tools for a model.
 *
 * The set is small on purpose, and uses the names Archil's own agent tools use,
 * so a model that has seen one has seen the other. Two additions: `sql` for
 * questions that are easier asked as a query, and `plan`, which prices a
 * command and shows what it would be allowed to touch without running it.
 *
 * A tool never throws. It returns the error as text, with the suggestion, so the
 * model can correct itself on the next step.
 *
 * `asFileSystem` goes the other way: it gives a context the shape the official
 * `disk` package's own tools take, for callers who already use those.
 */

import type { FileSystem } from "disk";

import { head, len, sorted, strip } from "./compat.ts";
import type { Context } from "./context.ts";
import { ArchilError } from "./errors.ts";

export const MAX_TOOL_OUTPUT = 12_000;

function clip(text: string, limit = MAX_TOOL_OUTPUT): string {
  const length = len(text);
  if (length <= limit) return text;
  return (
    head(text, limit) +
    `\n… ${length - limit} more characters. Narrow the request, or write the output to a file and read part of it.`
  );
}

export interface ToolSchema {
  type: "object";
  properties: Record<string, { type: string }>;
  required: string[];
  additionalProperties: false;
}

type Args = Record<string, unknown>;

export class Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolSchema;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly handler: (args: any) => Promise<string> | string;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(name: string, description: string, parameters: ToolSchema, handler: (args: any) => Promise<string> | string) {
    this.name = name;
    this.description = description;
    this.parameters = parameters;
    this.handler = handler;
  }

  /** Run the tool with a model's arguments. The answer is always text; an error comes back as `error: …`. */
  async call(args: Args = {}): Promise<string> {
    const wrong = this.#check(args ?? {});
    if (wrong) return `error: bad arguments for ${this.name}: ${wrong}`;
    try {
      return clip(await this.handler(args ?? {}));
    } catch (error) {
      if (error instanceof ArchilError) return `error: ${error}`;
      // the backend's own client: a refused request, a dropped connection
      return `error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
    }
  }

  /** What a Python call refuses by itself: a required argument left out, or one the tool does not take. */
  #check(args: Args): string | null {
    const { properties, required } = this.parameters;
    for (const name of required) {
      if (args[name] === undefined || args[name] === null) return `missing '${name}'`;
    }
    for (const name of Object.keys(args)) {
      if (!Object.hasOwn(properties, name)) return `unexpected '${name}'`;
    }
    return null;
  }

  toOpenAI(): { type: "function"; function: { name: string; description: string; parameters: ToolSchema } } {
    return { type: "function", function: { name: this.name, description: this.description, parameters: this.parameters } };
  }

  toAnthropic(): { name: string; description: string; input_schema: ToolSchema } {
    return { name: this.name, description: this.description, input_schema: this.parameters };
  }
}

function schema(required: string[], properties: Record<string, { type: string }>): ToolSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

const STR = { type: "string" };
const BOOL = { type: "boolean" };

export function buildTools(ctx: Context, names?: string[] | null): Tool[] {
  const readFile = ({ path }: { path: string }): Promise<string> => ctx.readText(path);

  const writeFile = async ({ path, content }: { path: string; content: string }): Promise<string> =>
    `wrote ${await ctx.write(path, content)} (${Buffer.byteLength(content)} bytes)`;

  const deleteFile = async ({ path }: { path: string }): Promise<string> => {
    await ctx.rm(path);
    return `deleted ${path}`;
  };

  const listFiles = async ({ path, recursive }: { path?: string; recursive?: boolean }): Promise<string> => {
    const entries = await ctx.ls(path ?? "", { recursive: recursive ?? false });
    return entries.map((f) => (f.path.endsWith("/") ? f.path : `${f.path}\t${f.size}`)).join("\n") || "(empty)";
  };

  const grep = async (args: { pattern: string; path?: string; ignore_case?: boolean }): Promise<string> => {
    const result = await ctx.grep(args.pattern, args.path || null, { ignoreCase: args.ignore_case ?? false }).run();
    const note = result.value.exhaustive
      ? ""
      : `\n(stopped early: ${result.value.stoppedReason}; results are a sample)`;
    return (result.stdout || "(no matches)") + note;
  };

  const runBash = async ({ command }: { command: string }): Promise<string> => {
    const result = await ctx.sh(command).run();
    const out = result.stdout + (strip(result.stderr) ? `\n[stderr]\n${result.stderr}` : "");
    return (
      `exit ${result.exitCode}\n${out}` + (result.truncated ? "\n(output was cut: only its first bytes are here)" : "")
    );
  };

  const sql = async ({ query }: { query: string }): Promise<string> => {
    const result = await ctx.sql(query).run();
    return result.ok ? result.stdout : `exit ${result.exitCode}\n${result.stderr}`;
  };

  const plan = async ({ command }: { command: string }): Promise<string> => String(await ctx.sh(command).explain());

  const paths =
    "Paths are <mount>/<path>; mounts: " + Array.from(ctx.mounts.values(), (m) => `${m.name} (${m.mode})`).join(", ") + ".";
  const tools = [
    new Tool("read_file", `Read a file. ${paths}`, schema(["path"], { path: STR }), readFile),
    new Tool(
      "write_file",
      "Create or replace a file on a writable mount.",
      schema(["path", "content"], { path: STR, content: STR }),
      writeFile,
    ),
    new Tool("delete_file", "Delete a file on a writable mount.", schema(["path"], { path: STR }), deleteFile),
    new Tool(
      "list_files",
      "List a directory. Directories end in '/'. Leave path empty to list the mounts.",
      schema([], { path: STR, recursive: BOOL }),
      listFiles,
    ),
    new Tool(
      "grep",
      "Regex search across files, run next to the data. One call however many files.",
      schema(["pattern"], { pattern: STR, path: STR, ignore_case: BOOL }),
      grep,
    ),
    new Tool(
      "run_bash",
      "Run a bash command in a fresh VM with the context mounted at the working directory. " +
        "Only files on the mounts persist between calls.",
      schema(["command"], { command: STR }),
      runBash,
    ),
    new Tool(
      "sql",
      "Run a DuckDB SQL query over files in the context, e.g. " +
        "select count(*) from read_json_auto('logs/api/**/*.ndjson').",
      schema(["query"], { query: STR }),
      sql,
    ),
    new Tool(
      "plan",
      "Show what a bash command would mount and cost, without running it.",
      schema(["command"], { command: STR }),
      plan,
    ),
  ];
  if (names != null) return tools.filter((t) => names.includes(t.name));
  // a context that can write nothing does not hand a model tools that could only fail
  const writable = [...ctx.mounts.values()].some((m) => m.writable);
  return writable ? tools : tools.filter((t) => t.name !== "write_file" && t.name !== "delete_file");
}

/** A context in the shape of the official `disk` package's `FileSystem`, plus the mount names. */
export interface ContextFileSystem extends FileSystem {
  /** The mount names. With this, the official tool layer treats the context as a workspace of disks. */
  diskNames(): string[];
}

/**
 * A context as the `FileSystem` of the official `disk` package, so the official
 * tools (`bindSpecs` from "disk/internal/tools", and the adapters built on it)
 * can be pointed at a composed context. Keys are context paths, `<mount>/<path>`.
 *
 * Every operation goes through the context, so its modes and narrowing apply:
 * a write to a read-only mount is refused here exactly as `ctx.write` refuses it.
 *
 * What does not carry over. `listObjects` treats its prefix as a directory, and
 * of its options reads `recursive` and `limit`. `grep` reads `directory`,
 * `pattern`, `recursive`, `ignoreCase`, `globs` and `maxResults`, and reports
 * the planned file count as `filesScanned`. `exec` runs the command as written,
 * with every mount attached; the official `run_bash` tool begins its commands
 * with `cd /mnt/archil`, a directory that exists in an Archil call and not on
 * the local backend. `createDiskTools` from "@archildata/ai-sdk" is typed to
 * take a `Disk` or a `Workspace`, so TypeScript needs a cast to hand it this.
 */
export function asFileSystem(ctx: Context): ContextFileSystem {
  const directory = (prefix: string | undefined): string => (prefix ?? "").replace(/^\/+|\/+$/g, "");
  return {
    diskNames: () => [...ctx.mounts.keys()],

    async getObject(key) {
      try {
        return await ctx.read(key);
      } catch (error) {
        // the official tools recognise a missing file by this status, as they do for the S3 API
        if (error instanceof ArchilError && error.code === "not_found") Object.assign(error, { status: 404 });
        throw error;
      }
    },

    async putObject(key, body) {
      await ctx.write(key, body instanceof ArrayBuffer ? new Uint8Array(body) : body);
      return {};
    },

    deleteObject: (key) => ctx.rm(key),

    async listObjects(prefix, options = {}) {
      const dir = directory(prefix);
      const roots = dir || !options.recursive ? [dir] : [...ctx.mounts.keys()];
      const entries = (await Promise.all(roots.map((root) => ctx.ls(root, { recursive: options.recursive })))).flat();
      const files = sorted(entries.filter((f) => !f.path.endsWith("/")), (f) => f.path);
      const kept = options.limit === undefined ? files : files.slice(0, options.limit);
      return {
        objects: kept.map((f) => ({
          key: f.path,
          size: f.size,
          etag: f.version || undefined,
          lastModified: f.modified ? new Date(f.modified * 1000) : undefined,
        })),
        commonPrefixes: sorted(entries.filter((f) => f.path.endsWith("/")).map((f) => f.path)),
        isTruncated: kept.length < files.length,
        keyCount: kept.length,
        prefix,
      };
    },

    async grep(options) {
      const result = await ctx
        .grep(options.pattern, directory(options.directory) || null, {
          recursive: options.recursive ?? false,
          ignoreCase: options.ignoreCase,
          globs: options.globs,
          maxResults: options.maxResults,
        })
        .run();
      return {
        matches: result.rows!.map((r) => ({ file: r.file, line: r.line, text: r.text })),
        stoppedReason: result.value.stoppedReason,
        filesScanned: result.plan!.files,
        containersDispatched: result.meta.calls,
        computeSecondsUsed: 0,
        durationMs: Math.round(result.meta.wallMs),
        listingMs: 0,
        grepMs: Math.round(result.meta.wallMs),
      };
    },

    async exec(command) {
      const result = await ctx.sh(command).run();
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timing: {
          totalMs: Math.round(result.meta.wallMs),
          queueMs: Math.round(result.meta.queueMs),
          executeMs: Math.round(result.meta.executeMs),
        },
      };
    },
  };
}
