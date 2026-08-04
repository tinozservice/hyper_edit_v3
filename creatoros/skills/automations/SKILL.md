---
name: automations
description: Set up hands-off systems — CreatorOS cloud automations (comment-to-DM funnels, workflows) that run on CreatorOS servers, and local scheduled agent runs via creatoros automations:create. Use when asked to automate replies, set up a funnel, run a recurring agent task, or "make this happen every day."
---

# Automations

## When to use

- "DM everyone who comments X on my post" → CreatorOS cloud comment-to-DM funnel.
- "Every morning, handle my comments" / "post from this folder daily" → local scheduled agent run.
- Reviewing or cleaning up existing automations.

## Two kinds of automation — pick the right one

1. **CreatorOS cloud** (runs on CreatorOS servers, no machine needed):
   comment-to-DM funnels and workflows. Best for deterministic
   if-this-then-that — a keyword comment triggers a DM with a link/offer.
2. **Local scheduled agent runs** (this machine, via launchd/cron): a full
   agent (Claude) executes a CreatorOS skill on a schedule. Best for judgment
   work — triaging comments, drafting content, picking assets.

## Prerequisites

- `creatoros auth:check` exits 0.
- For local runs: the target skill exists under `creatoros/skills/`, and the `claude` binary is installed on this machine.
- For local runs the machine must be awake at the scheduled time — remind the human of this; for always-on, use `--target railway`.

## Steps

### CreatorOS cloud comment-to-DM funnel

```sh
creatoros automations:list --cloud    # existing cloud automations
creatoros automations:create \
  --name "<funnel name>" \
  --profileId <profileId> \
  --accountId <accountId> \
  --platformPostId <platform-post-id> \
  --keywords "<word1,word2>" \
  --dmMessage "<the DM sent to each commenter>"
```
No `--schedule` flag → routes to cloud funnel creation. `--keywords` empty
means every comment triggers; `--matchMode exact` tightens matching (default
`contains`). Add `--commentReply "<text>"` to also reply publicly under the
trigger comment. Get IDs from `creatoros profiles:list` and
`creatoros accounts:list --pretty`; the platform post ID comes from
`creatoros posts:get <id> --pretty` (or the human's link). Manage with
`creatoros automations:get <id>`, `automations:update <id>`,
`automations:delete <id>`, `automations:logs <id>`.

For a **one-off** comment→DM (no standing funnel), use
`creatoros inbox:private-reply <postId> <commentId> --accountId <id> --message "<text>"`.

### Local scheduled agent run

```sh
creatoros automations:create daily-comments \
  --schedule "0 9 * * *" \
  --skill respond-to-comments
```
- macOS: installs + loads a launchd LaunchAgent (`com.creatoros.<name>`).
- Linux: appends a crontab entry.
- Windows: prints Task Scheduler instructions.

### Always-on cloud variant

```sh
creatoros automations:create daily-comments --schedule "0 9 * * *" --skill respond-to-comments --target railway
```
scaffolds `deploy/<name>/` (Dockerfile + railway.json + README). The README
lists required env vars — **make sure the human sets an Anthropic spend limit
before deploying.**

### Manage local runs

```sh
creatoros automations:list
creatoros automations:remove <name>
```

## Judgment rules

- Prefer CreatorOS cloud automations when the behavior is a simple trigger→action (funnels); save agent runs for work needing judgment. Servers beat laptops for reliability.
- Confirm schedule and timezone with the human before creating anything — "9am" means their timezone.
- For funnels: confirm the exact keyword and DM copy with the human before creating — the DM goes out automatically to strangers.
- Local agent runs use `--dangerously-skip-permissions`; the human should understand the agent acts unattended in this workspace. Say so when creating one.
- Never create an automation that posts unreviewed generated content unless the human explicitly opted into that.
- For plain scheduled *posts*, no automation is needed — `posts:create --scheduledAt` publishes from CreatorOS servers. Automations are for recurring *agent work* and funnels.

## Verification

- Local: `creatoros automations:list` shows the record; on macOS `launchctl list | grep com.creatoros` confirms it's loaded. Check the log file after the first scheduled run.
- Cloud: `creatoros automations:list --cloud` shows it; `creatoros automations:logs <id>` after the first trigger.
