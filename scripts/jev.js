// Jev (TypeSafe System One) client — plain fetch, no SDK dependency.
//
// Jev returns typed judgments (choice / noul / score) over a JSON state in a
// single fast round-trip. All questions in one request are evaluated in
// parallel against the state, so ask everything you need at once.
//
// Two ways to reach Jev:
//
//   1. OpenRouter (recommended — no TypeSafe account needed). The model is
//      chosen explicitly, e.g. a pinned version:
//        OPENROUTER_API_KEY=sk-or-...
//        JEV_MODEL=typesafe/jev-1.13          (or ~typesafe/jev-latest)
//        endpoint default: https://openrouter.ai/api/alpha/decisions
//      Docs: https://openrouter.ai/docs/guides/community/jev
//
//   2. TypeSafe directly (legacy):
//        TYPESAFE_API_KEY=...
//        JEV_MODEL=jev-latest (default)
//        endpoint default: https://api.typesafe.ai/v1/systemone
//
// Both speak the same System One protocol: { state, model, questions } →
// { answers, model, usage }. `JEV_ENDPOINT` overrides the endpoint (e.g.
// https://openrouter.ai/api/v1/systemone for the TypeSafe SDK path).
//
// Every caller must degrade gracefully when jevConfigured() is false.

const DEFAULT_ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/alpha/decisions',
  typesafe: 'https://api.typesafe.ai/v1/systemone',
};

// Pinned version by default on OpenRouter so answers stay reproducible; the
// alias `~typesafe/jev-latest` can be set via JEV_MODEL when tracking is wanted.
const DEFAULT_MODELS = {
  openrouter: 'typesafe/jev-1.13',
  typesafe: 'jev-latest',
};

const RETRYABLE_STATUSES = new Set([429, 502, 503, 524, 529]);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve the active Jev configuration. OpenRouter wins when both keys are set.
 * @returns {{provider:'openrouter'|'typesafe', endpoint:string, apiKey:string, model:string}|null}
 */
export function jevConfig() {
  const openrouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
  const typesafeKey = (process.env.TYPESAFE_API_KEY || '').trim();
  const endpointOverride = (process.env.JEV_ENDPOINT || '').trim();
  const modelOverride = (process.env.JEV_MODEL || '').trim();

  if (openrouterKey) {
    return {
      provider: 'openrouter',
      endpoint: endpointOverride || DEFAULT_ENDPOINTS.openrouter,
      apiKey: openrouterKey,
      model: modelOverride || DEFAULT_MODELS.openrouter,
    };
  }
  if (typesafeKey) {
    return {
      provider: 'typesafe',
      endpoint: endpointOverride || DEFAULT_ENDPOINTS.typesafe,
      apiKey: typesafeKey,
      model: modelOverride || DEFAULT_MODELS.typesafe,
    };
  }
  return null;
}

export function jevConfigured() {
  return Boolean(jevConfig());
}

/** Safe-to-log description of the active Jev setup (no secrets). */
export function jevInfo() {
  const config = jevConfig();
  if (!config) return { configured: false, provider: null, model: null, endpoint: null };
  return { configured: true, provider: config.provider, model: config.model, endpoint: config.endpoint };
}

/**
 * Ask Jev a set of questions over one state.
 * @param {string|object|array} state
 * @param {Record<string, {type:'choice'|'noul'|'score', instructions:any, criteria?:any}>} questions
 * @param {{model?:string, timeoutMs?:number}} [options]
 * @returns {Promise<{answers: Record<string, any>, model: string, provider?: string, usage: object, latencyMs: number}>}
 */
export async function askJev(state, questions, { model, timeoutMs = 15000 } = {}) {
  const config = jevConfig();
  if (!config) {
    throw new Error(
      'Jev is not configured: set OPENROUTER_API_KEY (optionally JEV_MODEL=typesafe/jev-1.13) or TYPESAFE_API_KEY in .dev.vars'
    );
  }

  const body = JSON.stringify({ state, model: model || config.model, questions });
  const started = Date.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(config.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      if (attempt < 2) {
        await sleep(300 * (attempt + 1));
        continue;
      }
      throw new Error(`Jev (${config.provider}) request failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (RETRYABLE_STATUSES.has(res.status)) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      const wait = retryAfter > 0 ? retryAfter * 1000 : 300 * (attempt + 1);
      await sleep(wait);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Jev (${config.provider}) ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    return { ...data, provider: data.provider || config.provider, latencyMs: Date.now() - started };
  }
  throw new Error('Jev is overloaded, retries exhausted');
}

// Question builders (mirror the SDK helpers).
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export const noul = (instructions, criteria) => (criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions });
export const score = (instructions, criteria) => ({ type: 'score', instructions, criteria });
