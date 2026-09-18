// Shared helpers for the production model adapters.
//
// Both providers are asked for JSON in the prompt rather than through a
// vendor-specific structured-output parameter: the orchestrator is
// provider-neutral by design, and a response contract that lives in the prompt
// is the only part of it that survives swapping a provider out.

const FENCED_JSON = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * Pulls the JSON object out of a model response.
 *
 * Models wrap JSON in prose or fences often enough that a bare JSON.parse is a
 * flaky contract. This tries the whole string, then a fenced block, then the
 * outermost braces, and reports what it actually received when all three fail —
 * a truncated body and an apology read very differently in a log.
 */
export function extractJsonObject(text, { what = "model response" } = {}) {
  const raw = String(text ?? "").trim();
  if (!raw) throw new Error("Empty " + what + "; expected a JSON object");

  const candidates = [raw];

  const fenced = raw.match(FENCED_JSON);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstBrace = raw.indexOf("{");
  const lastBrace = raw.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(raw.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    "Could not read a JSON object from the " + what + ". First 300 characters: " +
    raw.slice(0, 300)
  );
}

/**
 * Cost in USD for a call, from per-million-token rates.
 *
 * The budget system enforces a hard ceiling, so an adapter that under-reports
 * cost silently raises that ceiling. Rates are configuration, not constants,
 * because provider price changes must not require a code deploy.
 */
export function computeCost({ inputTokens, outputTokens, inputCostPerMTok, outputCostPerMTok }) {
  const input = (Math.max(0, Number(inputTokens) || 0) / 1_000_000) * Number(inputCostPerMTok || 0);
  const output = (Math.max(0, Number(outputTokens) || 0) / 1_000_000) * Number(outputCostPerMTok || 0);
  // Sub-cent precision matters: a long task is thousands of these added up.
  return Number((input + output).toFixed(6));
}

export function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * A fetch with a deadline and no retry of its own.
 *
 * Retry/backoff is the orchestrator's job (it owns the review-cycle ceiling and
 * the budget), so an adapter that also retried would multiply both.
 */
export async function postJson(url, { headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether an HTTP status is worth trying again.
 *
 * 429 and 5xx are transient; 400/401/403 mean the request or the key is wrong
 * and retrying just burns budget against the same error.
 */
export function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}
