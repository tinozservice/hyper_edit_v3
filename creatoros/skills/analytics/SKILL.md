---
name: analytics
description: Pull post performance and follower growth across all connected accounts — analytics:posts, analytics:daily, analytics:best-time, accounts:follower-stats — and turn the raw numbers into a readable report with trends and a recommendation. Use when asked how posts performed, how followers are growing, when to post, or "how are my socials doing?"
---

# Analytics (Posts + Followers)

## When to use

- "How did that post do?" / "What's working?" → post analytics.
- "Am I growing?" / "How many followers did I gain this week?" → follower analytics.
- "When should I post?" → best posting times.
- A scheduled weekly performance report.

## Prerequisites

- `creatoros auth:check` exits 0.
- `creatoros accounts:list --pretty` for account `_id`s and platforms (needed to interpret and filter results).

## Steps

1. **Establish the window.** Default to the last 7 days unless the human named one; always compare against the previous equal-length window so numbers have context.

2. **Post analytics** — what performed:
   ```sh
   creatoros analytics:posts --from <ISO> --to <ISO> --sortBy engagement --limit 20 --pretty
   ```
   Narrow with `--platform <name>` or `--postId <id>` for a single post. Then daily totals for trend shape:
   ```sh
   creatoros analytics:daily --from <ISO> --to <ISO> --pretty
   ```

3. **Follower analytics** — who's arriving:
   ```sh
   creatoros accounts:follower-stats --fromDate <ISO> --toDate <ISO> --granularity day --pretty
   ```
   Use `--granularity week` or `month` for longer windows, `--accountIds <id1,id2>` to narrow.

4. **Best posting times** (when relevant to the ask):
   ```sh
   creatoros analytics:best-time --pretty
   ```

5. **Write the report** — numbers into meaning:
   - Headline: the single most important movement (up or down) this window.
   - Per platform: followers now, net change vs. previous window, top 2–3 posts with their engagement.
   - One honest observation (what the data actually shows) and one concrete suggestion (what to do next), each tied to a specific number.

## Judgment rules

- **Never invent causality.** "The Tuesday reel got 3× median engagement" is a fact; "reels work better on Tuesdays" needs more than one data point — say which it is.
- **Absolute + relative, always.** "+400 followers" means nothing without "on 12k, vs +150 last week."
- **Flag anomalies instead of averaging over them.** One viral post distorts a weekly mean; report the median and call the outlier out separately.
- **Zero or missing data is a finding, not an error.** A platform returning nothing usually means no posts in the window or an account health issue — check `creatoros accounts:health --pretty` before blaming the numbers.
- **Don't dump JSON at the human.** The deliverable is the readable report; raw output only on request.

## Verification

- Every number in the report traces to a command you actually ran this session — no memory, no extrapolation.
- Date windows in the commands match the window the report claims to cover.
- If any command failed, the report says so for that section instead of silently omitting it.
