---
name: post-longform
description: Publish a longform video to YouTube with title, description, and tags via the creatoros CLI. Use when asked to upload a YouTube video, publish longform content, or update a published video's metadata.
---

# Post Longform (YouTube)

## When to use

- The human has a finished longform video and wants it on YouTube, now or scheduled.
- Updating title/description/tags on an already-published video.

## Prerequisites

- `creatoros auth:check` exits 0.
- YouTube account connected: find its `_id` in `creatoros accounts:list --pretty`.
- The video file exists, plus a title. Description and tags strongly recommended — ask the human if missing rather than inventing SEO copy.

## Steps

1. **Upload the video:**
   ```sh
   creatoros media:upload path/to/video.mp4
   ```
   Longform files are large — this can take a while; don't assume failure early.

2. **Publish or schedule:**
   ```sh
   creatoros posts:create \
     --text "<description>" \
     --title "<video title>" \
     --accounts <youtubeAccountId> \
     --media <uploadedUrl> \
     --tags tag1,tag2,tag3 \
     [--scheduledAt "<ISO-8601>" --timezone "<tz>"]
   ```

3. **For metadata updates on an already-published video:**
   ```sh
   creatoros posts:update-metadata <postId> --title "<new title>" --tags new,tags
   ```
   (Run `creatoros posts:update-metadata --help` for the exact flags supported.)

## Judgment rules

- Title under ~70 characters so it doesn't truncate in search; front-load the hook.
- Description: first 2 lines carry the pitch (that's what shows before "more"); links and chapters after.
- Tags are low-impact on YouTube — a handful of accurate ones beats twenty speculative ones.
- Never publish with a placeholder title like "Final_v3.mp4". If the title looks like a filename, stop and ask.

## Verification

- `posts:create` returns a post ID; check `creatoros posts:get <postId> --pretty` — status, title, and target account all correct.
- If publishing failed: `creatoros posts:retry <postId>` once, then report.
