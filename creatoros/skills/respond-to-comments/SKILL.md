---
name: respond-to-comments
description: Fetch recent comments across the user's social accounts, draft on-brand replies, like the content-free positives, hide spam/toxic comments, escalate sensitive topics (refunds, complaints, legal) to the human, and post replies via the creatoros CLI. Use when asked to reply to, like, or hide comments, manage engagement, or "handle the comments."
---

# Respond to Comments

## When to use

- The human asks you to reply to comments, "check the comments," or keep engagement warm.
- A scheduled automation run whose job is comment triage (e.g. a daily 9am run).
- After a big post went out and the human wants replies handled for the first few hours.

Do NOT use this skill for DMs (that's the `respond-to-dms` skill) or reviews (`inbox:reviews`).

## Prerequisites

- `creatoros` CLI authenticated: `creatoros auth:check` exits 0. If it fails, stop and tell the human to run `creatoros init`.
- At least one connected account: `creatoros accounts:list --pretty` returns accounts.
- Optional: a brand-voice note at `creatoros/BRAND_VOICE.md` in the workspace. If present, read it before drafting anything. If absent, infer voice from the user's 5 most recent published posts (`creatoros posts:list --pretty`).

## Steps

1. **Confirm auth and accounts:**
   ```sh
   creatoros auth:check
   creatoros accounts:list --pretty
   ```
   Note each account's `_id` and platform — you need the account ID to reply.

2. **Fetch recent comments** (last 24h by default; adjust `--since` to the time since the last run):
   ```sh
   creatoros inbox:comments --since <ISO-8601> --limit 50 --pretty
   ```
   Paginate with `--cursor` if there are more. To drill into one post:
   ```sh
   creatoros inbox:post-comments <postId> --pretty
   ```

3. **Triage every comment into one of five buckets** (see Judgment rules):
   - REPLY — normal engagement; draft a reply.
   - SKIP — spam, bots, trolls, bare emoji with nothing to say back.
   - ESCALATE — sensitive; do not reply, collect for the human.
   - LIKE-ONLY — positive but content-free ("🔥🔥"); like it instead of replying:
     ```sh
     creatoros inbox:like-comment <postId> <commentId> --accountId <accountId>
     ```
     (`inbox:unlike-comment` reverses it.)
   - HIDE — slurs, scam links, harassment of other commenters: things that
     shouldn't stay visible under the post but don't need the human:
     ```sh
     creatoros inbox:hide-comment <postId> <commentId> --accountId <accountId>
     ```
     Hiding is reversible (`inbox:unhide-comment`); prefer it over
     `inbox:delete-comment`, which is permanent and human-approval-only.

4. **Draft replies in the brand voice.** Short (1–2 sentences), specific to what the commenter said, no corporate filler, at most one emoji if the brand uses them. Never promise anything (dates, refunds, features) the human hasn't stated publicly.

5. **Post each reply:**
   ```sh
   creatoros inbox:reply <postId> --accountId <accountId> --commentId <commentId> --message "<reply text>"
   ```
   Omit `--commentId` only when replying to the post thread rather than a specific comment.

   When a comment deserves a private answer instead of a public one (a purchase question with details, someone sharing something personal), take it to DM:
   ```sh
   creatoros inbox:private-reply <postId> <commentId> --accountId <accountId> --message "<DM text>"
   ```

6. **Report to the human:** counts per bucket, every ESCALATE item quoted in full with a link/ID, and the replies you posted.

## Judgment rules

- **Escalate, never answer, when a comment involves:** refunds, billing, or order problems; complaints about the product or a bad experience; legal, medical, or financial claims; press/partnership inquiries; anything mentioning a minor or safety issue; harassment directed at a specific person.
- **Skip silently:** obvious spam links, crypto/promo bots, "check my page" comments, and trolls looking for a rise. Never feed trolls — a witty clapback is the human's call, not yours.
- **Hide vs skip:** skip is for noise that harms nobody; hide is for comments that damage the post's space (scams targeting followers, slurs, harassment). Never hide mere criticism — a hidden negative review the human would have wanted to see is worse than a troll left standing.
- **Tone:** match the commenter's energy but stay kind. Enthusiastic gets enthusiastic; a thoughtful question gets a substantive answer.
- **Don't argue.** If someone disagrees with the post's take, either engage genuinely with their point once, or leave it. No back-and-forth threads.
- **Rate sanity:** if there are more than ~30 REPLY-bucket comments, reply to the 30 with the most substance and tell the human how many you left.
- **When unsure which bucket, escalate.** A missed reply costs nothing; a bad reply is public.

## Verification

- Each `inbox:reply` call must exit 0 and echo the created reply. If a reply fails, retry once; if it fails again, include it in the report as failed — do not silently drop it.
- Spot-check: re-fetch one replied post with `creatoros inbox:post-comments <postId> --pretty` and confirm your reply appears.
- The final report to the human is part of success — no report, not done.
