// Jev (TypeSafe System One) client — plain fetch, no SDK dependency.
//
// Jev returns typed judgments (choice / noul / score) over a JSON state in a
// single fast round-trip. All questions in one request are evaluated in
// parallel against the state, so ask everything you need at once.
//
// Docs: https://docs.typesafe.ai/api  ·  key: https://console.typesafe.ai/keys
// Requires TYPESAFE_API_KEY in .dev.vars. Every caller must degrade
// gracefully when jevConfigured() is false.

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = process.env.JEV_MODEL || 'jev-latest';

export function jevConfigured() {
  return Boolean(process.env.TYPESAFE_API_KEY && process.env.TYPESAFE_API_KEY.trim());
}

/**
 * Ask Jev a set of questions over one state.
 * @param {string|object|array} state
 * @param {Record<string, {type:'choice'|'noul'|'score', instructions:any, criteria?:any}>} questions
 * @returns {Promise<{answers: Record<string, any>, model: string, usage: object, latencyMs: number}>}
 */
export async function askJev(state, questions, { model = DEFAULT_MODEL, timeoutMs = 8000 } = {}) {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error('Jev is not configured: set TYPESAFE_API_KEY in .dev.vars');

  const body = JSON.stringify({ state, model, questions });
  const started = Date.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(JEV_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 || res.status === 529) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      const wait = retryAfter > 0 ? retryAfter * 1000 : 300 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Jev ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json();
    return { ...data, latencyMs: Date.now() - started };
  }
  throw new Error('Jev is overloaded, retries exhausted');
}

// Question builders (mirror the SDK helpers).
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export const noul = (instructions, criteria) => (criteria ? { type: 'noul', instructions, criteria } : { type: 'noul', instructions });
export const score = (instructions, criteria) => ({ type: 'score', instructions, criteria });
