# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ClipWise (formerly HyperEdit) is an AI-powered video editor built with React 19, Remotion for motion graphics, and Cloudflare Workers for the backend. It's a Mocha platform app.

## Commands

```bash
npm install --legacy-peer-deps  # Install dependencies (required due to Vite 7 peer dep conflict)
npm run dev              # Start Vite dev server
npm run ffmpeg-server    # Start local FFmpeg server (port 3333) - run in separate terminal
npm run build            # TypeScript + Vite production build
npm run lint             # ESLint
npm run check            # Full validation: type check + build + deploy dry-run
npm run knip             # Check for unused dependencies
npm run cf-typegen       # Generate Cloudflare worker types
```

**Local development** requires both `npm run dev` and `npm run ffmpeg-server` running simultaneously.

## Architecture

```
src/
├── react-app/           # Frontend React SPA
│   ├── components/      # UI: Timeline, VideoPreview, AssetLibrary, AIPromptPanel, MotionGraphicsPanel
│   ├── hooks/           # useProject (main state), useFFmpeg, useVideoSession
│   └── pages/Home.tsx   # Main editor layout
├── worker/index.ts      # Hono backend API (AI editing via Gemini)
├── remotion/            # Motion graphics system
│   └── templates/       # 11 templates with registry in index.ts
scripts/
└── local-ffmpeg-server.js  # Session-based FFmpeg server with Whisper transcription
```

**Key patterns:**
- Multi-track timeline with 6 tracks: T1 (captions), V3 (top overlay), V2 (overlay), V1 (base video), A1/A2 (audio)
- `useProject()` hook manages all project state: assets, clips, playback, captions, rendering
- Local FFmpeg server (port 3333) handles sessions, asset storage, thumbnail generation, rendering, and Whisper-based transcription for captions
- Cloudflare Worker with D1 database and R2 bucket for production (configured in wrangler.json)

## State Management

The `useProject()` hook in `src/react-app/hooks/useProject.ts` is the central state manager. Key concepts:

- **Assets**: Source files (video/image/audio) with metadata, thumbnails, and stream URLs
- **TimelineClips**: Instances of assets placed on tracks with start time, duration, in/out points, and transforms
- **CaptionData**: Word-level timing from Whisper transcription, stored separately with style configuration keyed by clip ID. Caption clips on T1 have `assetId: ''` — never look for caption content in the asset library.
- **TimelineTabs**: Each tab stores its own `clips: TimelineClip[]` separately. `activeClips` in Home.tsx switches between main `clips` and `tab.clips`. All move/resize/delete operations must check `activeTabId !== 'main'` and dispatch to `updateTabClips` instead.

**Critical patterns:**
- The hook uses parallel refs (`tracksRef`, `clipsRef`, `settingsRef`, `sessionRef`) synced via `useEffect` so debounced/async operations read latest state without stale closures. This is essential for `saveProject` and `renderProject`.
- `ensureSession()` and `refreshAssets()` read `sessionRef`, not the `session` closure, so an agent that creates the session and refreshes assets in the same action (Obsidian import as the first asset) actually sees the new asset. Session ID is persisted in `localStorage` under key `clipwise-session`. If the FFmpeg server restarts, the stored session may be invalid (404), in which case localStorage is cleared and a new session is created on next asset upload.
- Tracks are always initialized client-side (never loaded from server) to guard against outdated server data.
- Auto-save is intentionally disabled to prevent excessive saves during drag operations. Saves must be triggered explicitly via `saveProject()`.
- `refreshAssets` appends `?v=Date.now()` to `streamUrl` for cache-busting after server-side file modifications.
- Assets with `aiGenerated: true` are deprioritized when selecting context video for new animation generation.

**Two parallel session systems exist:**
- `useProject` (modern) — multi-asset, full timeline
- `useVideoSession` (legacy) — single-video, still used exclusively for `generateChapters` in Home.tsx

## FFmpeg Server

The local FFmpeg server (`scripts/local-ffmpeg-server.js`, ~7700 lines) is a raw Node.js `http.createServer` with regex-based route matching. It handles all video processing, asset management, Remotion rendering, transcription, and fal.ai calls. The Cloudflare Worker only generates FFmpeg commands via Gemini — it does NOT execute them.

Key endpoints on `localhost:3333`:
- `POST /session/create` - Create new editing session
- `POST /session/{id}/assets` - Upload asset (auto-generates thumbnails)
- `POST /session/{id}/transcribe` - Whisper transcription for captions
- `POST /session/{id}/render` - Render final video
- `POST /session/{id}/render-motion-graphic` - Render Remotion animation
- `POST /session/{id}/generate-animation` - AI-generated Remotion animation (scene JSON from the LLM fallback pool → Remotion CLI renders)
- `POST /session/{id}/edit-animation` - Modify an existing animation's scene data in-place via the LLM fallback pool (same asset ID reused after re-render)
- `POST /session/{id}/process-asset` - Apply FFmpeg command to a specific asset (replaces in-place)
- `POST /session/{id}/extract-audio` - Split video into muted video + audio on A1
- `POST /session/{id}/generate-video` - Image-to-video via the fallback pool's Video provider (fal.ai fallback)
- `POST /session/{id}/restyle-video` - Video-to-video style transfer (DiCaprio)
- `POST /session/{id}/remove-video-bg` - Background removal (DiCaprio)
- `POST /session/{id}/generate-image` - fal.ai image generation (currently unused by the UI — Picasso agent was removed)
- `POST /session/{id}/giphy/*` - GIPHY search/trending/add proxy
- `POST /session/{id}/create-gif` - Animated GIF from image with motion effects
- `POST /session/{id}/shorts/start` + `GET /session/{id}/shorts/status/{jobId}` - Shorts generator (see below)
- `GET/POST /projects`, `POST /projects/{id}/open`, `PUT/DELETE /projects/{id}` - Saved projects (Save Project / Open Project)

**Media library**: AI-generated media (Remotion animations, generated images/videos, restyle/remove-bg, b-roll) is moved by `attachAsset()`/`relocateAiAsset()` into `MEDIA_LIBRARY_DIR` (default `D:\Project\Shorts\Media-AI`), sorted into `YYYY-MM-DD` folders. Uploads stay in the session dir. `assets-meta.json` stores `libraryRelative` so restored sessions find the files; deleting a session never removes library media. A startup migration moves AI assets created before the library existed. `MEDIA_LIBRARY_DIR` is configurable in `.dev.vars`.

**Saved projects**: `data/projects.json` maps project id → `{ name, sessionId, ... }`; each project also keeps a snapshot of `project.json` + `assets-meta.json` under `data/projects/<id>/`. Saved sessions are pinned (`isSessionPinned`) so the 2-hour auto-cleanup skips them; opening a project restores the session from disk or rebuilds it from the snapshot (missing uploads are dropped, library media survives).

Sessions persist to `/tmp/hyperedit-ffmpeg/sessions/{sessionId}/` with assets, renders, project.json, and assets-meta.json (stores `aiGenerated`, `duration`, `editCount`).

## TypeScript Configuration

Three separate tsconfig files:
- `tsconfig.app.json` - React app (ES2020, strict)
- `tsconfig.worker.json` - Cloudflare Worker
- `tsconfig.node.json` - Build tools

Path alias: `@/` → `./src/`

## Remotion Integration

Motion graphics use Remotion 4.x. Two distinct subsystems coexist:

**Static Templates** (`src/remotion/templates/`): 11 pre-built components registered in `MOTION_TEMPLATES` with categories (text, engagement, data, branding, mockup, showcase). Used by `MotionGraphicsPanel` with `@remotion/player` for live preview.

**AI-Generated Dynamic Animations** (`src/remotion/DynamicAnimation.tsx`): Takes `scenes: Scene[]` prop with types like title, steps, features, stats, chart, countdown, emoji, gif, lottie, etc. Composition `id="DynamicAnimation"` is what the FFmpeg server renders. Uses `@remotion/shapes`, `@remotion/animated-emoji`, `@remotion/gif`, `@remotion/lottie`, `@remotion/three`.

When working on templates, use the `/remotion-best-practices` skill for domain-specific guidance. Tailwind only scans `./src/react-app/` — not the remotion directory.

## Environment Variables

Required in `.dev.vars` for local development:
- `ANTHROPIC_API_KEY` - Claude Sonnet 5 (`claude-sonnet-5`), powers the actual chat/prompt orchestration for all three agents: Director's prompt→FFmpeg-command engine (worker `/api/ai-edit*`), DiCaprio's prompt enhancement, Creator OS's command planner
- `GEMINI_API_KEY` - Google AI, now only a last-resort fallback for multimodal helpers in `local-ffmpeg-server.js` (audio/video transcription fallback, B-roll image generation, chapter detection). Text-only LLM work (animation scene generation, transcript analysis, prompt enhancement) goes through the `/settings/llm` fallback pool (`data/llm.db`) first and only falls back to this key when the pool has no Chat provider.
- `FAL_API_KEY` - fal.ai for DiCaprio's Restyle Video / Remove Background calls and the Animate Image fallback (note: server aliases this to `FAL_KEY` for the fal.ai SDK). Animate Image prefers a **Video** provider in the `/settings/llm` fallback pool (OpenRouter async `/videos`, e.g. `heygen/heygen-video-1`) when one is enabled.
- `GIPHY_API_KEY` - GIF search
- `OPENAI_API_KEY` - Whisper fallback and Director voice replies (OpenAI TTS `tts-1`; without it voice mode falls back to browser `speechSynthesis`)
- `TYPESAFE_API_KEY` - Jev (TypeSafe System One). Powers Director workflow routing and Obsidian search reranking. Optional: every Jev call site degrades to keyword logic when unset. Key from https://console.typesafe.ai/keys
- `OBSIDIAN_VAULT_PATH` - Optional override for the Obsidian agent's vault (defaults to the Marketing OS Broll vault path hardcoded in `scripts/obsidian-agent.js`)

## AI Agents

The right panel has five tabs (four chat agents plus the Shorts generator). All panels are always mounted but toggled with `hidden` CSS class to preserve chat state.
- **Director** (AIPromptPanel): Video editing commands, captions, motion graphics, animations
- **Obsidian** (ObsidianPanel): Jev the media agent over the Marketing OS Broll vault; singular asks import one file, plural asks list them all (see below)
- **DiCaprio** (DiCaprioPanel): Video generation with Animate Image (Video provider from `/settings/llm`, or fal.ai Kling v1.5 as fallback), Restyle Video (LTX-2 19B), Remove Background (Bria)
- **Creator OS** (CreatorOSPanel): Publishes the rendered timeline to social media
- **Shorts** (ShortsPanel): Not a chat agent — a form that finds viral moments in a long video and cuts vertical shorts (see Shorts Generator below)

### Obsidian Agent = Jev the media agent (ObsidianPanel)

**Every media lookup goes through Jev.** Never hunt for logos online or guess vault paths: ask Jev in plain English and use the `file` it returns. Jev sits on the **Marketing OS Broll** vault (`~/Documents/Documents - My Mac (2)/Media /Marketing OS Broll/Marketing OS Broll`, note the trailing space in "Media "), a plain folder where every media file has a sidecar `.md` note with frontmatter (`name`, `type`, `pillar`, `brand`, `kind`, `file`, `poster`, `aliases`, `tags`, `colors`, `description`, dimensions, duration). Pillars: `ai-companies` (third-party marks, one hub folder per company), `brand-assets` (our own: creator-os, hoops-ai, no-code-academy, and persona profile pictures), `video-broll` (real clips with `.poster.jpg` frames). Kinds: `logo`, `icon`, `profile`, `clip`.

- **Endpoint**: `POST /jev` with `{ "message": "..." }` (also `POST /session/:id/obsidian/search`). Response: `{ media: true, mode: 'single'|'all', rows, total, more, intent, jev }`. Each row: `id`, `name`, `brand`, `kind`, `type`, `file` (vault-relative), `poster`, `size`, `width`, `height`, `duration`, `thumb` (URL on this server). Absolute path = vault path + `file`. `POST /session/:id/obsidian/import` with `{ itemIds }` copies rows into the session as assets.
- **Singular vs plural is the contract.** "the claude logo" → exactly one row (the best) plus `more`. "claude logos" → all 13. Plural words: logos, icons, clips, videos, pictures, avatars, assets, marks, files, all, every, each, multiple, footage, b-roll. Row zero of a plural answer equals the singular pick. The panel auto-imports a singular pick and lists a plural one.
- **How it works** (`queryVault` in `scripts/obsidian-agent.js`): one ~6k-token Jev call reads intent (plural Noul, kind/pillar/brand Choices over the live brand catalog, descriptive Noul). Code then applies the rules: family expansion for AI-company hubs (any brand in a hub returns the whole hub, exact brand first; exact-brand items elsewhere are included, e.g. the Claude tile), our own brand assets stay narrow, logo == icon, clips only when asked for clips/footage, brand narrowing only when a brand or alias is actually said, no brand → whole pillar. Ranking: exact brand > canonical "Brand logo" name > plain mark > logo > icon > profile > clip > resolution. A second per-item Jev call (Noul per candidate + best Choice) runs only for descriptive asks ("the pink jev logo", "basketball footage") or an unnamed-brand singular pick. Typical: 1 call, 200–600ms.
- **The server never reads the iCloud folder directly.** That Documents folder is iCloud-synced and macOS evicts its files to `dataless` placeholders whenever disk is tight (this Mac runs near full); a plain `readFileSync` on an evicted file blocks until iCloud re-downloads it, which froze the whole Node server. `syncMirror()` in `scripts/obsidian-agent.js` spawns `rsync -a --delete` from the vault into `~/.clipwise/vault-mirror/<vault name>` (non-synced, cannot be evicted) as a child process, at server start and whenever the index is older than 5 minutes; `loadIndex()`, thumbnails and imports all read the mirror. `GET /session/:id/obsidian/status` exposes `mirror.{syncing,lastSyncedAt,error}` and the panel polls it while syncing. If asks return "still syncing", iCloud is slow-walking downloads (~1 file/s); freeing disk space stops the evictions.
- **Never swap brands.** An empty result for a named brand means it isn't on file; say so rather than substituting another company's mark. Keyword fallback exists only when `TYPESAFE_API_KEY` is unset.

### Director voice mode + Jev routing

The Director no longer requires a video to be uploaded before you can talk to it: the input, send, attach and voice controls are always enabled, and workflows that need footage reply with "upload a video first" instead. The Director can be driven voice-to-voice. `src/react-app/hooks/useVoiceDirector.ts` wraps the browser Web Speech API for input (Chrome/Edge/Safari; no server round-trip) and speaks replies via `POST /director/tts` (OpenAI `tts-1`, voice `onyx`, overridable with `DIRECTOR_TTS_VOICE`/`DIRECTOR_TTS_MODEL`), falling back to `speechSynthesis` on any non-200. In `AIPromptPanel.tsx`:
- The mic button is push-to-talk: the final transcript is submitted through `handleSubmit(undefined, text)` (the `overrideText` parameter exists for this).
- The headphones button toggles **voice mode**: every new assistant message is spoken (`toSpeakable` strips markdown/code and caps length), then the mic re-arms automatically unless the panel is busy. The mic is never open while the Director is speaking.
- Workflow routing asks Jev first: `routeWithJev` posts the prompt plus editor context (including whether an image is attached in the chat) to `POST /director/route`, where `handleDirectorRoute` asks one Choice over the 14 `WorkflowType`s (descriptions in `DIRECTOR_WORKFLOWS`) and one Noul ("does this refer to the existing animation?") in a single call, applies deterministic overrides toward `edit-animation` when an animation is in context and toward `animate-image` when an attached image plus an explicit image-to-video request would otherwise be routed to FFmpeg/Remotion, and returns `{workflow, confidence, latencyMs}`. The client uses it only when `confidence >= 0.35` and the call answers within 4s; otherwise the keyword `determineWorkflow` decides. Both results are logged to the console for comparison. `animate-image` runs DiCaprio's image-to-video (`/session/:id/generate-video`, Video provider from `/settings/llm`) and drops the result on V2 at the playhead.
- **Notes as instructions (`.txt`/`.md`)**: uploads with those extensions become `text` assets (server type detection; no thumbnail/duration). They appear in the asset library and can be attached in the Director chat via the paperclip, drag-and-drop, or the **Add asset from library** (`+`) picker. `buildNoteContext()` fetches the file (capped at 6000 chars per note) and prepends `[Attached note: …]` to the prompt, so the content informs both Jev routing and the workflow LLM call. Text notes are never placed on the timeline (drop is ignored) and are filtered out of `attachedAssetIds` sent to the Remotion generator.
- **Obsidian voice mode**: `ObsidianPanel.tsx` uses the same hook with a `VoicePersona` (`BUTLER`): OpenAI voice `fable` with butler delivery `instructions` (the server switches to `gpt-4o-mini-tts` whenever instructions are sent, since `tts-1` ignores them), and a browser fallback that prefers the macOS "Grandpa (English (UK))" / "Daniel" en-GB voices. Replies are one clipped sentence ("Vercel logo, in your media now. 12 more exist."). In voice mode a singular ask imports its file and a plural ask of ≤15 rows imports all of them; larger plural asks are listed and Jev asks which.
- **Timeline operations and vault media** (`timeline-op`, `vault-media` workflows): the same routing call also asks Jev for a `DirectorTimelineOp` (operation, target, track, destination track, direction, size, position; see `src/react-app/lib/directorOps.ts`), with numbers (seconds, mm:ss, percentages) parsed by regex in `parseTimelineNumbers`. The client sends the active timeline's clips as labels (`V1 · intro.mp4 · 0:00–0:30`) so Jev can target a clip by name (`clip:<id>`) as well as `selected`, `at_playhead`, `first`, `last`, `all_on_track`, `everything`. `executeDirectorTimelineOp` in Home.tsx runs delete, split, move, trim/extend start/end, set_duration, scale, position, seek, play, pause, clear_track against the active tab through the existing handlers and returns a one-line result for the chat. `placeVaultMedia` asks Jev the media agent (`/session/:id/obsidian/search`), imports the row(s), refreshes assets, and places them: images on V3 at the playhead with a size/position preset (default small, top-right), videos on V1 if V1 is empty else V2, audio on A1; a plural ask lays files out back to back. A confident timeline verb overrides a generic FFmpeg/animation bucket server-side unless an animation is in context.
- `scripts/jev.js` is the shared plain-`fetch` client (`askJev(state, questions)`, `choice/noul/score` builders, retries 429/529). Ask all questions for one decision in a single request; Jev evaluates them in parallel.

### Shorts Generator (ShortsPanel)

Fifth tab in the right panel (`ShortsPanel.tsx`). Finds the most viral moments in a long talking video and cuts them into ready-to-post vertical shorts. Built in-house — there is no third-party dependency (a GitHub "shorts generator" repo was evaluated and rejected as malware; do not vendor external code for this).

Pipeline (`runShortsJob` in `scripts/local-ffmpeg-server.js`, start/poll job pattern like Creator OS):
1. **Transcribe** via the shared `getOrTranscribeVideo()` (local Whisper, cached per asset in `session.transcriptCache`).
2. **Rank** with Claude Sonnet 5 (`rankHighlightsWithClaude`, one call): classifies content type + pacing, returns ~3x `count` candidate spans scored 0–100 on a virality framework, plus a ≤7-word hook per span. Requires `ANTHROPIC_API_KEY`.
3. **Snap** each candidate to real word boundaries preferring sentence ends (`snapCandidateToWords`), enforce min/max duration, **dedupe** overlapping spans by score (`dedupeCandidates`), take top N.
4. **Cut + reframe** with FFmpeg: `crop` to the target ratio (`cropPosition` left/center/right), `scale` to 1080x1920 / 1080x1350 / 1080x1080, and burn the hook into the first 3s with `drawtext`. Each hook line is a separate `drawtext` filter — FFmpeg 8 renders a tofu box for embedded newlines, so never pass multi-line text to one drawtext.
5. **Register** each clip as a session asset with `shortMeta` (score, title, hook, reason, source range, ratio) and `sourceAssetId`, persisted in `assets-meta.json` and exposed by `GET /assets`. The panel lists shorts from `assets.filter(a => a.shortMeta)`, so results survive reloads. "Add to timeline" (`handleAddShortToTimeline` in Home.tsx) appends the short to V1 on the main tab and flips the canvas to the short's aspect ratio.

Source-video picker excludes `aiGenerated` assets and existing shorts. Needs a speaking video (fails with a clear error under 20 transcribed words).

### Creator OS Agent

Wraps the `@creatoros/cli` npm package (a branded wrapper around `@zernio/cli`, both real dependencies in `node_modules`). The CLI itself is vendored into the repo's runtime via npm, and its bundled skill playbooks + agent surface docs are scaffolded into `creatoros/` and `.claude/commands/` (generated once via `installSkills`/`generateSurfaces` from the package — see git history for the one-off scaffold script; re-run `npx @creatoros/cli sync` to refresh them).

- **Key entry**: the user's first chat message in the panel is treated as their CreatorOS API key (`sk_` + 64 hex chars, from the CreatorOS iOS app → Settings → API Key), not a command. `CreatorOSPanel.tsx` renders that first turn as a password-masked single-line input.
- **Backend endpoints** (`scripts/local-ffmpeg-server.js`): `POST /session/:id/creatoros/init` (validates via `creatoros auth:check` then persists via `creatoros auth:set` — the key is saved by the CLI itself to `~/.zernio/config.json`; this server never stores it), `POST /session/:id/creatoros/chat`.
- **Ask-first, remember-after**: a fresh browser (no `hyperedit-creatoros-connected` flag in localStorage) always gets the "what's your API key?" greeting — it never trusts a pre-existing `~/.zernio/config.json` credential on first load. Only after the user explicitly connects through this chat does the frontend set that localStorage flag; on later mounts, its presence is what gates a background call to `GET /session/:id/creatoros/status` to silently re-verify and skip the greeting. This is intentionally a single-user local dev convenience (see `CreatorOSPanel.tsx` header comment) — don't make `/creatoros/status` unconditional again, or the greeting will silently get skipped for users who never connected.
- **Chat handler**: sends the user's prompt to Claude Sonnet 5 (via `callClaude()`, a plain-`fetch` wrapper around the Anthropic Messages API — no SDK dependency) along with the real `@zernio/cli` `SKILL.md` (command reference) and `creatoros/CLAUDE.md` as grounding context. Claude returns a strict JSON plan of primitive steps (`render`, or `cli` with a command + args), which the server executes for real via `runCreatorOS()` (spawns the local `creatoros` binary). Steps chain together with `{{RENDER_PATH}}` / `{{MEDIA_URL}}` / `{{ACCOUNT_IDS}}` placeholder tokens — e.g. "download the video in the timeline and upload to all socials" becomes render → `media:upload` → `accounts:list` → `posts:create`.
- **Render step** calls the existing `/session/:id/render` endpoint via an internal loopback `fetch` rather than duplicating the FFmpeg export logic.
- **Safety**: commands matching `:delete`/`:cancel` are blocked server-side unless the user's message contains explicit confirming language (yes/confirm/go ahead).
- Requires `ANTHROPIC_API_KEY` in `.dev.vars` for the chat planner; `init`/`status` work without it since they call the CLI directly.

### Claude Sonnet 5 orchestration (Director / DiCaprio / Creator OS)

The three chat-driven agents all delegate their actual prompt understanding to Claude Sonnet 5 (`claude-sonnet-5`) via `ANTHROPIC_API_KEY`, called directly over the Messages API with plain `fetch` (no `@anthropic-ai/sdk` dependency, so it works identically in the Cloudflare Worker and the Node ffmpeg server):
- **Director**: `src/worker/index.ts` — `callClaude()` there is a separate copy (workers bundle independently from `scripts/local-ffmpeg-server.js`) backing `/api/ai-edit/start` and `/api/ai-edit`, which turn a natural-language edit request into `{"command", "explanation"}` FFmpeg JSON.
- **DiCaprio**: `handleGenerateVideo` (Kling image-to-video) and `handleRestyleVideo` (LTX-2 style transfer) in `scripts/local-ffmpeg-server.js` use `callClaude()` to expand a short user prompt into a detailed cinematic one before calling fal.ai. `handleRemoveVideoBg` has no prompt to enhance.
- **Creator OS**: `handleCreatorOSChat`, see above.

This was a deliberate, scoped swap — only the free-text "what does the user want" entry points moved to Claude. Text-only Gemini call sites in `local-ffmpeg-server.js` (animation scene generation, transcript analysis, prompt enhancement) now go through the `/settings/llm` fallback pool (`generateText()` → `chatCompletion()`) and only use `GEMINI_API_KEY` when the pool is empty. The remaining `GoogleGenAI` sites are multimodal (audio/video transcription fallback, B-roll image generation, chapter detection) and still require `GEMINI_API_KEY`.

## UI Layout Conventions

- **Track placement**: AI-generated animations always go on V2. B-roll images go on V3 with default `scale: 0.2`, centered.
- **Image clips** default to 5-second duration everywhere (`addClip`, `handleDropAsset`, `addCaptionClip`).
- **Caption word timestamps** are relative to clip start, not absolute project time. Conversion happens in `getPreviewLayers()`.
- **Caption chunking**: Max 5 words per chunk OR when there's a 0.7s pause between words (hardcoded in Home.tsx `handleTranscribeAndAddCaptions`).
- **Ripple delete**: When `autoSnap` is true, deleting a clip shifts subsequent clips on the same track backward via the `ripple` parameter on `deleteClip`.
- **`splitClip`** has a 0.05s guard — returns `null` if split point is within 50ms of either edge.
- **Properties panel**: Left panel bottom half shows `CaptionPropertiesPanel` when selected clip is on T1, otherwise `ClipPropertiesPanel`.
- **Resizable panels**: Left (assets + properties), right (AI agents), and timeline height are all user-resizable via `ResizablePanel`/`ResizableVerticalPanel`.

## Local Whisper Transcription

Captions use local OpenAI Whisper (`scripts/whisper-transcribe.py`). Audio is read via `resolveAudioSource(session, videoAsset, hint)`: the video's own track when it has usable sound, otherwise the A1 audio that `extract-audio` split off it (linked by `sourceAssetId`, or an `audioAssetId` hint from the client). Both `handleTranscribe` (captions) and the shared `getOrTranscribeVideo()` (shorts, GIFs, b-roll) go through it, so a muted V1 never produces the "Output file does not contain any stream" FFmpeg error. Setup:
```bash
pip3 install openai-whisper torch
```
- **MPS (Apple GPU) is NOT supported** — Whisper's sparse tensors crash on MPS. The script runs on CPU only. Do not add `device="mps"`.
- Falls back to Gemini API if local Whisper is unavailable (but Gemini struggles with long audio files).
- The `base` model is used by default (good speed/accuracy balance).

## Dead Air Removal

The remove dead air workflow (`POST /session/{id}/remove-dead-air`) is stable — keep the segment-based approach below; change it only deliberately. How it works:
0. The client sends `assetId` (the asset of the selected or earliest V1 clip, never "first video in the library") and, when the audio was extracted to A1, `audioAssetId`. The server listens to whichever file actually carries sound: the video if it has a usable audio stream (mean above -60dB), else the linked A1 audio asset (matched by `sourceAssetId`). A silent video with no linked audio returns a clear 400.
1. FFmpeg `silencedetect` finds silence periods (threshold: -26dB, min duration: 0.4s — set in `Home.tsx handleRemoveDeadAir`)
2. Each non-silent segment is extracted individually with `-ss`/`-t` and re-encoded (`libx264 ultrafast, aac`)
3. Segments are concatenated with `-c copy` into the final output
4. The original file is replaced in-place on disk. When silence was read from the A1 audio, that audio file is cut with the identical segment list in one `atrim`+`concat` filter pass (sample-accurate; `aselect` does not drop samples on FFmpeg 8) and replaced in place too, so V1 and A1 stay in sync (`audio: {assetId, duration}` in the response)
5. Frontend calls `refreshAssets()` to get a cache-busted URL and updates the V1 clip duration, plus the linked A1 clip when `audio` is returned

The segment-based approach (extract + concat) is required — single-pass filter approaches (`select`/`aselect`, `trim`/`atrim`) drop audio streams. The `VideoPreview` component uses a stable `key` on the base video element and manually calls `video.load()` when the source URL changes, preserving browser audio permission from the user's play gesture.

## Build & Deployment

- Vite config uses `@cloudflare/vite-plugin` and `@getmocha/vite-plugins`. `chunkSizeWarningLimit: 5000` due to Remotion's size.
- `wrangler.json` app name is a UUID (Mocha app ID). SPA routing via `not_found_handling: "single-page-application"`.
- No tests exist in the codebase. No testing framework is configured.
