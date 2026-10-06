// Astra on OpenAI: the architect and the reviewer.
//
// Plain HTTPS to the Chat Completions endpoint with a strict JSON-schema
// response format, so the answer is JSON of the expected shape. No SDK: this
// repository does not depend on one, and the surface used here is one request
// and one response.
//
// Errors report the HTTP status and the provider's error type and code — never
// the response body, which can quote the request back, and the request
// contains the customer's code.
import { BilledFailure } from './governor.js';
import { DevError, ERR } from './errors.js';
import { analysisPrompt, planPrompt, reviewPrompt, type AnalysisRequest, type PlanRequest, type ReviewRequest } from './prompts.js';
import { approxTokens, ceilingOf, costOf, type ModelPrice } from './pricing.js';
import { providerHttpError, providerUnavailable, type AstraProvider, type PreparedCall, type ProviderResult } from './providers.js';
import { ANALYSIS_SCHEMA, ARCHITECTURE_PLAN_SCHEMA, parseModelJson, REVIEW_SCHEMA } from './schemas.js';

export interface OpenAIAstraConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
  price: ModelPrice;
  maxOutputTokens: { plan: number; review: number };
  timeoutMs: number;
}

type Fetch = typeof globalThis.fetch;

export function createOpenAIAstra(cfg: OpenAIAstraConfig, deps: { fetch?: Fetch } = {}): AstraProvider {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;

  function prepare(name: 'architecture_plan' | 'review' | 'analysis', prompt: { system: string; user: string }, schema: object, maxOut: number): PreparedCall {
    const inputTokens = approxTokens(prompt.system) + approxTokens(prompt.user) + approxTokens(JSON.stringify(schema));
    return {
      ceilingMinor: ceilingOf(cfg.price, inputTokens, maxOut),
      run: async (): Promise<ProviderResult> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
        let response: Response;
        try {
          response = await doFetch(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model: cfg.model,
              messages: [
                { role: 'system', content: prompt.system },
                { role: 'user', content: prompt.user },
              ],
              response_format: { type: 'json_schema', json_schema: { name, schema, strict: true } },
              max_completion_tokens: maxOut,
            }),
            signal: controller.signal,
          });
        } catch (e) {
          const aborted = (e as Error)?.name === 'AbortError';
          throw new DevError(ERR.PROVIDER_FAILED, aborted ? 'Astra did not answer in time.' : 'Astra could not be reached.', {
            httpStatus: 502,
            retryable: true,
          });
        } finally {
          clearTimeout(timer);
        }

        let body: any = null;
        try {
          body = await response.json();
        } catch {
          body = null;
        }

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw providerUnavailable('astra', 'the configured credential was rejected.');
          }
          const detail = [body?.error?.type, body?.error?.code].filter(Boolean).join('/');
          throw providerHttpError('astra', response.status, detail);
        }

        const usage = {
          inputTokens: Number(body?.usage?.prompt_tokens ?? 0),
          outputTokens: Number(body?.usage?.completion_tokens ?? 0),
        };
        const costMinor = costOf(cfg.price, usage);
        const choice = body?.choices?.[0];
        if (choice?.message?.refusal) {
          throw new BilledFailure(new DevError(ERR.PROVIDER_FAILED, 'Astra declined this request.', { retryable: false }), costMinor);
        }
        if (choice?.finish_reason === 'length') {
          throw new BilledFailure(new DevError(ERR.PROVIDER_OUTPUT, 'Astra ran out of output room.', { retryable: false }), costMinor);
        }
        let raw: unknown;
        try {
          raw = parseModelJson(String(choice?.message?.content ?? ''));
        } catch (e) {
          throw new BilledFailure(e, costMinor);
        }
        return { raw, usage, costMinor, model: String(body?.model ?? cfg.model) };
      },
    };
  }

  return {
    info: { role: 'astra', vendor: 'openai', mode: 'real', model: cfg.model, available: true, price: cfg.price },
    preparePlan: (req: PlanRequest) => prepare('architecture_plan', planPrompt(req), ARCHITECTURE_PLAN_SCHEMA, cfg.maxOutputTokens.plan),
    prepareReview: (req: ReviewRequest) => prepare('review', reviewPrompt(req), REVIEW_SCHEMA, cfg.maxOutputTokens.review),
    prepareAnalysis: (req: AnalysisRequest) => prepare('analysis', analysisPrompt(req), ANALYSIS_SCHEMA, cfg.maxOutputTokens.review),
  };
}
