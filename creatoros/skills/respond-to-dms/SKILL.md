---
name: respond-to-dms
description: Triage and reply to DMs across the user's social accounts — fetch conversations, draft on-brand replies, archive (hide) finished or spam threads, escalate sensitive conversations to the human. Use when asked to answer DMs, check messages, clean up the inbox, or "handle my messages."
---

# Respond to DMs

## When to use

- The human asks you to reply to DMs, "check my messages," or keep the inbox at zero.
- A scheduled automation run whose job is message triage.
- Cleaning up: archiving stale or spam conversations.

Do NOT use this skill for post comments (that's `respond-to-comments`) or reviews (`inbox:reviews`).

## Prerequisites

- `creatoros` CLI authenticated: `creatoros auth:check` exits 0. If it fails, stop and tell the human to run `creatoros init`.
- At least one connected account: `creatoros accounts:list --pretty` returns accounts. Note each account's `_id` — every inbox command needs `--accountId`.
- Optional: a brand-voice note at `creatoros/BRAND_VOICE.md`. If present, read it before drafting anything.

## Steps

1. **Confirm auth and accounts:**
   ```sh
   creatoros auth:check
   creatoros accounts:list --pretty
   ```

2. **Fetch active conversations** (per account or across all):
   ```sh
   creatoros inbox:conversations --status active --limit 20 --pretty
   ```
   Filter with `--accountId <id>` or `--platform <facebook|instagram|twitter|bluesky|reddit|telegram>`. Paginate with `--cursor`.

3. **Read each conversation before replying** — never answer from the preview:
   ```sh
   creatoros inbox:messages <conversationId> --accountId <accountId> --pretty
   ```

4. **Triage every conversation into one of four buckets** (see Judgment rules):
   - REPLY — a genuine question or conversation; draft a reply.
   - ARCHIVE — spam, bots, or a finished thread; hide it from the active inbox:
     ```sh
     creatoros inbox:update-conversation <conversationId> --accountId <accountId> --status archived
     ```
     (Reversible: `--status active` un-hides it.)
   - ESCALATE — sensitive; do not reply, collect for the human.
   - LEAVE — needs nothing yet (e.g. the human's own last message is awaiting their counterpart).

5. **Send each reply:**
   ```sh
   creatoros inbox:send <conversationId> --accountId <accountId> --message "<reply text>"
   ```
   Attach media with `--mediaUrl <url>` (upload first via `creatoros media:upload <file>`). Then mark the thread read:
   ```sh
   creatoros inbox:mark-read <conversationId> --accountId <accountId>
   ```

6. **Fixing your own mistakes** (only your own sent messages, where the platform supports it):
   ```sh
   creatoros inbox:edit-message <conversationId> <messageId> --accountId <accountId> --message "<corrected>"
   creatoros inbox:delete-message <conversationId> <messageId> --accountId <accountId>
   ```

7. **Report to the human:** counts per bucket, every ESCALATE thread quoted with its conversation ID, and the replies you sent.

## Judgment rules

- **Escalate, never answer, when a DM involves:** refunds, billing, or order problems; complaints; legal, medical, or financial questions; press/partnership/sponsorship inquiries; anything romantic, harassing, or involving a minor; requests for the human's personal contact info.
- **DMs are private but not consequence-free.** Screenshots exist. Nothing in a DM that couldn't survive being posted publicly.
- **Never send links, prices, or promises** the human hasn't already stated publicly or pre-approved.
- **Don't start conversations.** `inbox:create-conversation` is only for when the human explicitly asks you to DM someone specific — never cold outreach on your own initiative.
- **Archive is the "hide," not delete.** Archiving is reversible; deleting messages is not. Only delete a message you yourself sent in error.
- **When unsure which bucket, escalate.** A slow reply costs little; a bad DM from the brand account costs trust.

## Verification

- Each `inbox:send` must exit 0 and echo the created message. If it fails, retry once; if it fails again, report it as failed — never silently drop it.
- Spot-check one replied conversation with `inbox:messages` and confirm your reply appears.
- Archived threads no longer appear in `inbox:conversations --status active`.
- The final report to the human is part of success — no report, not done.
