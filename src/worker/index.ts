import { Hono } from "hono";
import { cors } from "hono/cors";

interface Env {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_CHAT_MODEL?: string;
  /** JSON array of { name, base_url, api_key, model, timeout_ms?, max_retries? } */
  LLM_FALLBACKS?: string;
  /** Local editor server that owns the SQLite fallback pool (default http://localhost:3333). */
  LLM_BRIDGE_URL?: string;
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  ASSETS: Fetcher;
  MOCHA_USERS_SERVICE_API_URL: string;
  MOCHA_USERS_SERVICE_API_KEY: string;
}

interface LlmProvider {
  id?: number | null;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  timeout_ms?: number;
  max_retries?: number;
}

type ChatContent = string | Array<string | { text?: string }>;

const LLM_REQUEST_MAX_TOKENS = 1500;

const FFMPEG_SYSTEM_PROMPT = `You are a video editing AI assistant that helps users edit their videos using FFmpeg commands.

When the user describes what they want to do with their video, you should:
1. Understand the editing request
2. Generate the appropriate FFmpeg command to accomplish it
3. Explain what the command will do in simple terms

IMPORTANT: Always use "input.mp4" as the input filename and "output.mp4" as the output filename in your commands.

Return ONLY valid JSON with exactly this structure, no markdown fences, no commentary:
{"command": "the FFmpeg command", "explanation": "simple explanation"}

Common video editing tasks:
- Remove dead air/silence (removes silent audio AND corresponding video): ffmpeg -y -i input.mp4 -af "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-40dB:stop_periods=-1:stop_duration=0.5:stop_threshold=-40dB,asetpts=N/SR/TB" -vf "setpts=N/FRAME_RATE/TB" -shortest output.mp4
- Trim/cut video from start to end time: ffmpeg -y -i input.mp4 -ss 00:00:10 -to 00:00:30 -c copy output.mp4
- Speed up 1.5x: ffmpeg -y -i input.mp4 -filter:v "setpts=0.667*PTS" -filter:a "atempo=1.5" output.mp4
- Speed up 2x: ffmpeg -y -i input.mp4 -filter:v "setpts=0.5*PTS" -filter:a "atempo=2.0" output.mp4
- Slow down 0.5x: ffmpeg -y -i input.mp4 -filter:v "setpts=2.0*PTS" -filter:a "atempo=0.5" output.mp4
- Remove audio completely: ffmpeg -y -i input.mp4 -an -c:v copy output.mp4
- Remove background noise from audio: ffmpeg -y -i input.mp4 -af "highpass=f=200,lowpass=f=3000,afftdn=nf=-25" -c:v copy output.mp4
- Resize to 1280x720: ffmpeg -y -i input.mp4 -vf "scale=1280:720" output.mp4
- Resize to 1920x1080: ffmpeg -y -i input.mp4 -vf "scale=1920:1080" output.mp4
- Crop center 640x480: ffmpeg -y -i input.mp4 -vf "crop=640:480" output.mp4
- Rotate 90° clockwise: ffmpeg -y -i input.mp4 -vf "transpose=1" output.mp4
- Rotate 90° counter-clockwise: ffmpeg -y -i input.mp4 -vf "transpose=2" output.mp4
- Increase volume 50%: ffmpeg -y -i input.mp4 -af "volume=1.5" -c:v copy output.mp4
- Decrease volume 50%: ffmpeg -y -i input.mp4 -af "volume=0.5" -c:v copy output.mp4
- Add fade in/out (1 second): ffmpeg -y -i input.mp4 -vf "fade=t=in:st=0:d=1,fade=t=out:st=END-1:d=1" -af "afade=t=in:st=0:d=1,afade=t=out:st=END-1:d=1" output.mp4
- Extract first 30 seconds: ffmpeg -y -i input.mp4 -t 30 -c copy output.mp4
- Remove first 10 seconds: ffmpeg -y -i input.mp4 -ss 10 -c copy output.mp4
- Convert to MP4 (re-encode): ffmpeg -y -i input.mp4 -c:v libx264 -c:a aac output.mp4

Always use -y flag to overwrite output. Provide safe, valid FFmpeg commands.`;

// LLM orchestration for the Director's prompt→FFmpeg engine. All providers are
// OpenAI-compatible ({ base_url, api_key, model }) and tried in order:
//   1. the SQLite fallback pool managed at /settings/llm, reached through the
//      local editor server (http://localhost:3333/llm/providers/runtime)
//   2. env.LLM_FALLBACKS (JSON array)
//   3. legacy ANTHROPIC_API_KEY / OPENAI_API_KEY from .dev.vars
// Anthropic is reached through its OpenAI SDK-compatible endpoint, so no
// native Anthropic SDK is needed in the Workers runtime.
const PROVIDER_CACHE_MS = 10_000;
let providerCache: { at: number; providers: LlmProvider[]; bridgeUrl: string } | null = null;

function bridgeUrlFor(env: Env): string {
  return (env.LLM_BRIDGE_URL || "http://localhost:3333").replace(/\/+$/, "");
}

function envProviders(env: Env): LlmProvider[] {
  if (env.LLM_FALLBACKS) {
    try {
      const parsed = JSON.parse(env.LLM_FALLBACKS);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((p) => p && p.base_url && p.api_key && p.model)
          .map((p) => ({
            name: String(p.name || p.base_url),
            base_url: String(p.base_url).replace(/\/+$/, ""),
            api_key: String(p.api_key),
            model: String(p.model),
            timeout_ms: Number(p.timeout_ms) || 30_000,
            max_retries: Number(p.max_retries) || 0,
          }));
      }
    } catch (error) {
      console.error("LLM_FALLBACKS is not valid JSON:", error);
    }
  }

  const providers: LlmProvider[] = [];
  if (env.ANTHROPIC_API_KEY) {
    providers.push({
      name: "Anthropic (OpenAI-compatible)",
      base_url: (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1").replace(/\/+$/, ""),
      api_key: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL || "claude-sonnet-5",
      timeout_ms: 30_000,
      max_retries: 1,
    });
  }
  if (env.OPENAI_API_KEY) {
    providers.push({
      name: "OpenAI",
      base_url: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
      api_key: env.OPENAI_API_KEY,
      model: env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
      timeout_ms: 30_000,
      max_retries: 1,
    });
  }
  return providers;
}

async function loadProviders(env: Env): Promise<{ providers: LlmProvider[]; bridgeUrl: string }> {
  const bridgeUrl = bridgeUrlFor(env);
  const now = Date.now();
  if (providerCache && now - providerCache.at < PROVIDER_CACHE_MS) {
    return { providers: providerCache.providers, bridgeUrl: providerCache.bridgeUrl };
  }
  try {
    const res = await fetch(`${bridgeUrl}/llm/providers/runtime`, { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = (await res.json()) as { providers?: LlmProvider[] };
      const list = (data.providers || []).filter((p) => p.base_url && p.api_key && p.model);
      if (list.length) {
        providerCache = { at: now, providers: list, bridgeUrl };
        return { providers: list, bridgeUrl };
      }
    }
  } catch {
    // Local editor server not reachable (e.g. deployed Worker) — fall back to env.
  }
  const providers = envProviders(env);
  providerCache = { at: now, providers, bridgeUrl };
  return { providers, bridgeUrl };
}

// Best-effort activity log for the /settings/llm page; never blocks a reply.
function logToBridge(bridgeUrl: string, entry: Record<string, unknown>): void {
  void fetch(`${bridgeUrl}/llm/logs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "worker", ...entry }),
    signal: AbortSignal.timeout(1500),
  }).catch(() => undefined);
}

async function callProvider(provider: LlmProvider, system: string, userMessage: string, maxTokens: number): Promise<string> {
  const response = await fetch(`${provider.base_url}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${provider.api_key}`,
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userMessage },
      ],
    }),
    signal: AbortSignal.timeout(provider.timeout_ms || 30_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    const error = new Error(`HTTP ${response.status}${errText ? `: ${errText.slice(0, 300)}` : ""}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: ChatContent }; text?: string; finish_reason?: string }>;
  };
  const choice = data.choices?.[0];
  const content: ChatContent = choice?.message?.content ?? choice?.text ?? "";
  const text = Array.isArray(content)
    ? content.map((part) => (typeof part === "string" ? part : part?.text || "")).join("")
    : String(content || "");
  if (!text.trim()) {
    // Reasoning models can burn the whole budget on hidden reasoning tokens.
    const error = new Error(
      choice?.finish_reason === "length"
        ? "empty completion: token budget exhausted by reasoning before any content (finish_reason=length)"
        : "provider returned an empty completion"
    ) as Error & { budgetExhausted?: boolean };
    error.budgetExhausted = choice?.finish_reason === "length";
    throw error;
  }
  return text;
}

async function callClaude(env: Env, system: string, userMessage: string): Promise<string> {
  const { providers, bridgeUrl } = await loadProviders(env);
  if (!providers.length) {
    throw new Error(
      "No LLM providers configured. Add one at http://localhost:5173/settings/llm or set ANTHROPIC_API_KEY / OPENAI_API_KEY in .dev.vars."
    );
  }

  let lastError: Error | null = null;
  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const configuredTries = Math.max(1, (provider.max_retries ?? 0) + 1);
    const maxTries = configuredTries + 1; // one extra slot for a token-budget bump
    let budget = LLM_REQUEST_MAX_TOKENS;
    let budgetBumped = false;

    for (let attempt = 0; attempt < maxTries; attempt += 1) {
      const startedAt = Date.now();
      try {
        const text = await callProvider(provider, system, userMessage, budget);
        logToBridge(bridgeUrl, {
          kind: "chat",
          provider_name: provider.name,
          model: provider.model,
          fallback_index: index,
          attempt,
          success: 1,
          latency_ms: Date.now() - startedAt,
          status_code: 200,
        });
        return text;
      } catch (error) {
        lastError = error as Error;
        const status = (error as { status?: number }).status;
        const retryable = status === undefined || status === 429 || status >= 500;
        logToBridge(bridgeUrl, {
          kind: "chat",
          provider_name: provider.name,
          model: provider.model,
          fallback_index: index,
          attempt,
          success: 0,
          latency_ms: Date.now() - startedAt,
          status_code: status ?? null,
          error: lastError.message,
        });
        const budgetExhausted = (error as { budgetExhausted?: boolean }).budgetExhausted;
        if (budgetExhausted && !budgetBumped && budget < 32768) {
          budgetBumped = true;
          budget = Math.max(budget * 4, 1024);
          continue; // same provider, larger token budget
        }
        if (retryable && attempt < configuredTries - 1) continue;
        break; // next provider in the fallback list
      }
    }
  }

  throw new Error(`All ${providers.length} LLM provider(s) failed. Last error: ${lastError?.message || "unknown"}`);
}

interface FFmpegCommandResult {
  command: string;
  explanation: string;
}

function parseFFmpegResponse(responseText: string): FFmpegCommandResult {
  try {
    return JSON.parse(responseText);
  } catch {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    return jsonMatch
      ? JSON.parse(jsonMatch[0])
      : { command: "", explanation: "Failed to parse response" };
  }
}

// In-memory store for pending requests (dev only)
const pendingRequests = new Map<string, { status: string; result?: FFmpegCommandResult; error?: string }>();

const app = new Hono<{ Bindings: Env }>();

app.use("/*", cors());

// Start an AI edit job - returns immediately with a job ID
app.post("/api/ai-edit/start", async (c) => {
  try {
    const body = await c.req.json();
    const prompt = body.prompt;

    if (!prompt) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    const jobId = crypto.randomUUID();
    pendingRequests.set(jobId, { status: "processing" });

    // Process in background using waitUntil
    c.executionCtx.waitUntil(
      (async () => {
        try {
          const responseText = await callClaude(c.env, FFMPEG_SYSTEM_PROMPT, prompt);
          const result = parseFFmpegResponse(responseText);
          pendingRequests.set(jobId, { status: "complete", result });
        } catch (error) {
          console.error("AI edit error:", error);
          pendingRequests.set(jobId, {
            status: "error",
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      })()
    );

    return c.json({ jobId, status: "processing" });
  } catch (error) {
    console.error("Start job error:", error);
    return c.json({ error: "Failed to start job" }, 500);
  }
});

// Check job status
app.get("/api/ai-edit/status/:jobId", async (c) => {
  const jobId = c.req.param("jobId");
  const job = pendingRequests.get(jobId);

  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  if (job.status === "complete") {
    pendingRequests.delete(jobId); // Clean up
    return c.json({ status: "complete", success: true, ...job.result });
  }

  if (job.status === "error") {
    pendingRequests.delete(jobId); // Clean up
    return c.json({ status: "error", error: job.error });
  }

  return c.json({ status: "processing" });
});

// Legacy endpoint - simple synchronous call (fallback)
app.post("/api/ai-edit", async (c) => {
  try {
    const body = await c.req.json();
    const prompt = body.prompt;

    if (!prompt) {
      return c.json({ error: "Prompt is required" }, 400);
    }

    const responseText = await callClaude(c.env, FFMPEG_SYSTEM_PROMPT, prompt);
    const result = parseFFmpegResponse(responseText);

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("AI edit error:", error);
    return c.json(
      {
        error: "Failed to process AI request",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

// SPA fallback — serve the built client for any non-API GET route (e.g. a
// refresh on /settings/llm). `not_found_handling: single-page-application`
// makes the assets binding return index.html for unknown paths.
app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
