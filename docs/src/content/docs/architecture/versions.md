---
title: Versions and clocks
description: Views, feeds and turns all need to know whether a file changed. They compare versions, and on Archil a version rests on a clock. What that means, and how the SDKs close the gap.
---

Three parts of seaway ask the same question: has this file changed?

- A **view** asks it of its inputs, to decide whether to rebuild.
- A **feed** asks it of everything under a path, to decide what to hand over.
- A **turn** asks it of the main line at commit, to decide whether it conflicts.

All three answer it from a listing, by comparing each file's **version**: a string that changes when the content does. A listing reads no data, which is why a freshness check and a poll make no call. Each reads one small file of its own: the view's state, or the feed's cursor.

## What a version is

| Backend | Version | Changes on every write? |
|---|---|---|
| local | the modification time in nanoseconds, and the size | yes |
| Archil | the ETag, and the modification time in whole seconds | not quite |

An ETag alone is not enough on Archil. An ETag follows a file's content only when the file was written through the object API. A file rewritten in place through a mount keeps the ETag it was created with. So the version there carries the modification time too.

## The gap

That time is in whole seconds. So on Archil, a file rewritten in place, at the same size, twice within one second looks unchanged.

The window is narrow: the same path, the same size, the same second, through a mount. But a view that missed it would stay stale, and a turn that missed it would overwrite a change.

## How the SDKs close it

They do not trust a version that is under about a second and a half old. A file that new could still be rewritten without its version moving.

| Part | What it does with a file that new |
|---|---|
| a **view** | records a provisional fingerprint, and builds once more on its next refresh |
| a **feed** | remembers the file provisionally, and hands it over again on the next poll |
| a **turn** | waits out the difference before it takes its snapshot |

A provisional version or fingerprint ends in `~`, which never equals a later one. You will see it in a [view's state file](/architecture/files-on-disk/#view-state) and in a [feed's cursor](/architecture/files-on-disk/#a-feed-cursor).

The wait in a turn is at most a second and a half, and only when something was written that recently. Usually there is none.

## What it rests on

This rests on the caller's clock being within half a second of Archil's. If it is further off, a file rewritten in place, at the same size, within a second of its last change can still go unnoticed.

## What you will notice

- **A view builds twice.** Built from an input written a moment ago, it builds once more on the next refresh. After that it is fresh.
- **A feed hands a file over twice.** That is within its contract: delivery is at least once.
- **A turn takes a second longer to begin,** when it starts straight after a write.

None of this happens on the local backend, where every write changes a file's version.

## Across backends

Versions from one backend mean nothing on the other. A cursor or a view's state does not carry over between a local root and a disk on Archil: the first poll hands over everything, and the first refresh builds.

Both SDKs compute the same version for the same file on the local backend, so they can work on one root. The [interop check](/architecture/two-sdks/#the-interop-check) is what holds them to that.

## What would move this to the server

For a turn, the question is "has this path changed on the main line since my checkpoint?" The platform can answer that exactly, and the client can only infer it from listings. A native conditional apply would take the turn's part of this off the client altogether. It is the third of the things [seaway asks of the platform](/architecture/platform/).

## Next

:::cards
- [How turns work](/architecture/transactions/) Where a turn waits, and why.
- [Views](/guides/views/) What a fingerprint covers.
- [Feeds](/guides/feeds/) Why handling has to be safe to repeat.
:::
