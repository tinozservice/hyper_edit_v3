---
name: schedule-posts
description: Batch-schedule a content calendar — from a CSV plan or a folder of media assets — across future dates and accounts. CreatorOS servers publish at the scheduled times, so nothing needs to keep running locally. Use when asked to schedule a week/month of content, load a content calendar, or queue up posts.
---

# Schedule Posts (Content Calendar)

## When to use

- The human hands you a content calendar (CSV, spreadsheet export, or markdown table) and says "schedule these."
- A folder of assets (videos/images) plus instructions like "spread these over the next two weeks, one per day at 6pm."
- Rebuilding the queue after a strategy change.

## Prerequisites

- `creatoros auth:check` exits 0.
- Account IDs known: `creatoros accounts:list --pretty` (map platform names in the calendar to account `_id`s).
- The content **exists**: every row's media file is on disk, every caption is written. Never schedule a post whose asset or copy is missing — flag the gap to the human instead.
- Human-provided or agreed: timezone, posting times, and date range.

## Steps

1. **Parse the calendar.** Expected CSV columns (be flexible about naming):
   `date, time, platforms, caption, media_path, title, tags`.
   For a folder of assets with no CSV, propose a schedule (dates × time slot) and get the human's OK before scheduling.

2. **Validate every row before touching the API:**
   - media file exists on disk
   - caption non-empty and within platform limits:
     ```sh
     creatoros validate:post-length --text "<caption>" --pretty
     ```
   - date is in the future
   Report all invalid rows and stop if more than half fail — the calendar format is probably misread.

3. **Upload media** for each row (returns a URL to use in the post):
   ```sh
   creatoros media:upload <path/to/asset.mp4>
   ```
   Capture the returned URL per row.

4. **Schedule each post** with an ISO 8601 `--scheduledAt` in the human's timezone:
   ```sh
   creatoros posts:create \
     --text "<caption>" \
     --accounts <accountId1>,<accountId2> \
     --media <uploadedUrl> \
     --scheduledAt "2026-07-15T18:00:00" \
     --timezone "America/New_York" \
     [--title "<title>"] [--tags tag1,tag2]
   ```
   Record the returned post ID per row.

   For calendars over ~15 rows, prefer one bulk call — build a JSON array and dry-run it first:
   ```sh
   creatoros posts:bulk-upload --file calendar.json --dryRun
   creatoros posts:bulk-upload --file calendar.json
   ```

5. **Tell the human it's done and that they can close the laptop** — CreatorOS servers handle publishing at each `scheduledAt`; nothing needs to stay running locally.

## Judgment rules

- **Never invent content.** Empty caption cell → ask, don't improvise. Missing asset → skip the row and report it.
- **Don't double-book.** Check `creatoros posts:list --pretty` for already-scheduled posts in the window; if a slot collides, shift yours by 30–60 min and note it.
- **Respect stated times exactly.** If the human said 6pm, schedule 6pm — don't "optimize" to a best-time slot unless they asked. If they ask for optimal times, use:
  ```sh
  creatoros analytics:best-time --pretty
  ```
- **Timezone discipline:** one timezone for the whole batch, stated in the final report. If the calendar has no timezone and the human didn't say, ask.
- **Same asset, multiple platforms:** one `posts:create` with comma-separated `--accounts` when caption is identical; separate calls when captions differ per platform.
- **Past dates in the calendar** are always a mistake — surface them, never silently bump to tomorrow.

## Verification

- Every `posts:create` must exit 0 and return a post ID. Collect them.
- After the batch, verify the queue:
  ```sh
  creatoros posts:list --pretty
  ```
  and spot-check 2–3 posts:
  ```sh
  creatoros posts:get <postId> --pretty
  ```
  Confirm status is scheduled, and `scheduledAt`/accounts match the calendar.
- Final report: table of row → post ID → scheduled time → accounts, plus any skipped rows and why.
