interface Env {
  GEMINI_API_KEY: string;
  // Legacy single-provider keys — still used as an ad-hoc fallback when the
  // SQLite pool (scripts/llm-pool.js, /settings/llm) has no entry.
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_CHAT_MODEL?: string;
  // JSON array of { name, base_url, api_key, model, timeout_ms?, max_retries? }
  LLM_FALLBACKS?: string;
  // Local editor server that owns the fallback pool (default http://localhost:3333)
  LLM_BRIDGE_URL?: string;
  R2_BUCKET: R2Bucket;
  DB: D1Database;
  MOCHA_USERS_SERVICE_API_URL: string;
  MOCHA_USERS_SERVICE_API_KEY: string;
}
