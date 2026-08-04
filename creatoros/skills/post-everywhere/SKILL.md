---
name: post-everywhere
description: Publish one piece of content — text, image, or video — to every connected platform (or a chosen subset) in a single posts:create call across all account IDs, validating length limits first. Use when asked to "post this everywhere," cross-post an announcement, or publish to all platforms at once.
---

# Post Everywhere (All Platforms)

## When to use

- The human has one piece of content and wants it on all (or several) platforms at once — an announcement, a launch, a photo, a link drop.
- Not the right skill when the content is format-specific: vertical short video → `post-shortform`; multi-part thread → `post-threads`; YouTube longform → `post-longform`. This skill is for one post, many platforms.

## Prerequisites

- `creatoros auth:check` exits 0.
- All target account IDs: `creatoros accounts:list --pretty` — collect the `_id` of every account the human wants (default: all of them; confirm the list before publishing).
- The content exists: caption written, any media file on disk. Never post placeholders.

## Steps

1. **Confirm the target accounts.** List platform + handle for each `_id` you're about to post to and get the human's OK (or their standing approval) — "everywhere" should never silently include an account they forgot was connected.

2. **Validate the text against every platform's limit:**
   ```sh
   creatoros validate:post-length --text "<caption>" --pretty
   ```
   If it fails for some platform, either trim once for all, or split into two `posts:create` calls — full caption for the roomy platforms, tightened version for the strict ones. Ask the human which, unless the trim is trivial.

3. **Upload media once** (if any) — the URL is reusable across all platforms:
   ```sh
   creatoros media:upload path/to/asset.jpg
   ```
   Optionally pre-check it: `creatoros validate:media --url <url> --pretty`.

4. **Publish in one call across all accounts:**
   ```sh
   creatoros posts:create \
     --text "<caption>" \
     --accounts <id1,id2,id3,...> \
     [--media <url>] \
     [--title "<title>"] \
     [--hashtags <tag1,tag2>]
   ```
   `--title` applies where platforms use one (YouTube, Reddit). Add `--scheduledAt <ISO-8601> --timezone <tz>` to schedule instead of publishing now (CreatorOS servers handle it — nothing needs to keep running locally).

5. **Verify per platform:**
   ```sh
   creatoros posts:get <postId> --pretty
   ```
   Check the status for every target account — a post can succeed on four platforms and fail on the fifth. Retry failures once with `creatoros posts:retry <postId>`.

## Judgment rules

- **One size rarely fits all.** A link-heavy caption suits X/Facebook but reads spammy on Instagram; hashtags help Instagram but clutter LinkedIn-style platforms. Offer a per-platform tweak when the mismatch is glaring — but keep it to one extra call, not one call per account.
- **Reddit is not a billboard.** If a subreddit target is involved, check `creatoros validate:subreddit` first and respect its rules — cross-posted marketing copy gets accounts banned.
- **Confirm before "everywhere."** The account list confirmation in step 1 is not optional on the first run.
- **Media formats differ.** A 16:9 video is fine for X/Facebook but wrong for Reels; if the human insists on "everywhere" with mismatched media, say which platforms will look off and let them choose.

## Verification

- `posts:create` exits 0 and returns a post ID.
- `posts:get <id> --pretty` shows a success/scheduled status for **every** target account; every failure is reported to the human with the platform's error, never silently dropped.
- Report: where it went live (platform + link/ID where available), where it's scheduled, and anything that failed.
