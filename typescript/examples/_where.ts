/**
 * Where an example runs.
 *
 *     node examples/quickstart.ts             # the local backend: no account, nothing leaves this machine
 *     node examples/quickstart.ts --archil    # the same code on Archil (set ARCHIL_API_KEY and ARCHIL_REGION)
 *
 * On Archil, every disk an example names gets a prefix that is new for the run. So an
 * example never opens a disk that already exists in your account, and two runs never
 * meet. When it ends it prints the disks it created. Add `--cleanup` to have it delete
 * them; deleting a disk also removes the branches and checkpoints a run left on it.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as archil from "seaway";

export const onArchil = process.argv.includes("--archil");
const prefix = onArchil ? `px-${randomUUID().slice(0, 6)}-` : "";
const names: string[] = [];

/** The backend for this run: a temporary directory, or your Archil account. */
export function backend(tag: string): archil.LocalBackend | archil.ArchilBackend {
  if (!onArchil) return new archil.LocalBackend({ root: mkdtempSync(join(tmpdir(), `archil-${tag}-`)) });
  const live = new archil.ArchilBackend();
  let finished = false;
  process.on("beforeExit", async () => {
    if (finished) return;
    finished = true;
    await finish(live);
  });
  return live;
}

/** `archil.disk`, under this run's prefix when the run is on Archil. */
export function disk(name: string, mode: archil.Mode = "read", options: archil.SourceOptions = {}): archil.Source {
  if (!names.includes(prefix + name)) names.push(prefix + name);
  return archil.disk(prefix + name, mode, options);
}

async function finish(live: archil.ArchilBackend): Promise<void> {
  const client = await live.client();
  // the official Disk has more on it than this SDK calls, `name` and `delete()` among them
  type Created = archil.ArchilDisk & { name: string; delete(): Promise<void> };
  const created: Created[] = [];
  for (const name of names) created.push(...((await client.disks.list({ name })) as Created[]));
  if (!created.length) return;
  console.log(`\nThis run created ${created.length} disk(s) on Archil:`);
  for (const d of created) console.log(`  ${d.id}  ${d.name}`);
  if (process.argv.includes("--cleanup")) {
    for (const d of created) await d.delete();
    console.log("All of them were deleted (--cleanup).");
  } else {
    console.log("They are yours to look at. Run with --cleanup next time to delete them when the example ends.");
  }
}
