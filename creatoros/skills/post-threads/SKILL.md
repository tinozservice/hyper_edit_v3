---
name: post-threads
description: Publish multi-part text threads to Threads and X (Twitter) — split long-form ideas into a hook-first sequence of posts. Use when asked to post a thread, a tweetstorm, or turn a longer piece into thread format.
---

# Post Threads (Threads / X)

## When to use

- The human wants a multi-part thread on Threads or X, or asks you to turn a blog post / script / notes into one.
- Single text posts also fit here when the target is Threads/X.

## Prerequisites

- `creatoros auth:check` exits 0.
- Threads and/or X account IDs from `creatoros accounts:list --pretty`.
- The thread content exists or the human has approved your draft. Show the full thread text for approval before posting unless the human pre-approved autonomy.

> **Note:** the current CLI's `posts:create` has no dedicated thread-items flag — each part is its own post. Check `creatoros posts:create --help` for a threading option before falling back to sequential posts, and check whether `posts:bulk-upload` JSON supports a thread structure.

## Steps

1. **Draft the thread.** Hook in part 1 (it decides whether anyone reads on), one idea per part, a closer with the call-to-action. Number parts only if the brand does.

2. **Validate lengths per platform** (X and Threads have different limits):
   ```sh
   creatoros validate:post-length --text "<part text>" --pretty
   ```
   Split any over-limit part at a sentence boundary.

3. **Post part 1**, capture its post ID:
   ```sh
   creatoros posts:create --text "<part 1>" --accounts <accountId>
   ```

4. **Post subsequent parts in order.** Check `creatoros posts:create --help` for a reply/thread flag; if none exists, post sequentially and note in the report that parts are standalone posts rather than a linked chain.

5. **Cross-post:** repeat for the second platform if the human wants both Threads and X — don't mix account IDs into one call, since parts must chain per platform.

## Judgment rules

- Threads live or die on the hook. If part 1 is weak, tighten it before posting, or flag it.
- 4–8 parts is the sweet spot; past ~10, suggest longform instead.
- Never pad to reach a part count, never split mid-sentence.
- If posting fails midway through a thread, STOP — a half-posted thread is worse than none. Report which parts went out and ask the human whether to delete or continue.

## Verification

- Every part's `posts:create` exits 0 with a post ID.
- `creatoros posts:get <firstPartId> --pretty` — confirm published state.
- Report: platform(s), part count, IDs in order, and whether parts are chained as replies or standalone.
