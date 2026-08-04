---
name: post-shortform
description: Publish a short vertical video with a caption to TikTok, Instagram Reels, and YouTube Shorts simultaneously — upload the media once, then one posts:create across all shortform accounts. Use when asked to post a short, a Reel, a TikTok, or "put this clip everywhere."
---

# Post Shortform Video

## When to use

- The human gives you a short vertical video (usually < 90s, 9:16) and wants it on TikTok / Reels / Shorts — any or all.
- A scheduled run that publishes today's clip from a known folder.

## Prerequisites

- `creatoros auth:check` exits 0.
- The video file exists on disk. Never post without the content existing.
- Shortform account IDs known: `creatoros accounts:list --pretty` — collect the `_id` of each TikTok / Instagram / YouTube account the human wants.
- A caption, either provided or approved by the human.

## Steps

1. **Validate the media** before uploading:
   ```sh
   creatoros validate:media --url <or-local-checks> --pretty
   ```
   At minimum check locally: file exists, extension is a video format, vertical aspect if the human expects Reels/TikTok.

2. **Upload once** — the returned URL is reusable across platforms:
   ```sh
   creatoros media:upload path/to/clip.mp4
   ```

3. **Check caption length** against every target platform:
   ```sh
   creatoros validate:post-length --text "<caption>" --pretty
   ```

4. **Publish (or schedule) to all shortform accounts in one call:**
   ```sh
   creatoros posts:create \
     --text "<caption>" \
     --accounts <tiktokId>,<instagramId>,<youtubeId> \
     --media <uploadedUrl> \
     [--title "<title for YouTube Shorts>"] \
     [--scheduledAt "<ISO-8601>" --timezone "<tz>"] \
     [--hashtags tag1,tag2]
   ```
   For TikTok, check creator posting constraints first if unsure:
   ```sh
   creatoros accounts:tiktok-creator-info <tiktokAccountId> --pretty
   ```

## Judgment rules

- Caption tone follows the brand voice (see `creatoros/BRAND_VOICE.md` if present); hashtags: a few relevant ones, not a wall.
- If the video is landscape (16:9), warn the human before posting it as a Reel/TikTok — it will look wrong. Post only on their confirmation.
- Don't split into per-platform posts unless captions must differ; one call keeps IDs and retries simple.
- If one platform's validation fails (length, media rules), post to the passing platforms and report the failure — don't block everything.

## Verification

- `posts:create` exits 0 and returns a post ID.
- Confirm per-platform status:
  ```sh
  creatoros posts:get <postId> --pretty
  ```
- If a platform shows failed, retry once with `creatoros posts:retry <postId>`, then report honestly.
