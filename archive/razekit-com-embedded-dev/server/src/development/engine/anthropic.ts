// Fable on Anthropic: the implementer.
//
// Uses the official SDK, loaded only when Fable is actually configured — it is
// an optional dependency, and a deployment without it (or without a key) gets
// a Fable that says it is unavailable rather than a process that fails to boot.
//
// Request shape, per the current Messages API:
//   • streamed, because a whole codebase is a long output and a non-streamed
//     request at this max_tokens would hit the HTTP timeout;
//   • structured output against EXECUTION_PLAN_SCHEMA, so the answer is JSON
//     of the expected shape rather than prose to be scraped;
//   • powerful models only: server-side refusal fallbacks are OFF unless the
//     operator turns them on, so a declined request stops the step instead of
//     silently running on another model. When they are on, the model that
//     actually served the answer must still be on the approved list;
//   • thinking left at the model default (always on for Fable), depth set by
//     effort.
//
// Cost is computed from the usage the response reports, at the configured
// price. The reservation made before the call assumed every one of
// max_tokens would be used, so the bill cannot exceed it.
import type Anthropic from '@anthropic-ai/sdk';
import { BilledFailure } from './governor.js';
import { DevError, ERR } from './errors.js';
import { implementPrompt, type ImplementRequest } from './prompts.js';
import { approxTokens, ceilingOf, costOf, type ModelPrice } from './pricing.js';
import { providerHttpError, providerUnavailable, type FableProvider, type ProviderResult } from './providers.js';
import { EXECUTION_PLAN_SCHEMA, parseModelJson } from './schemas.js';

export interface AnthropicFableConfig {
  apiKey: string;
  model: string;
  price: ModelPrice;
  maxOutputTokens: number;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  timeoutMs: number;
  /** The approved models. The answer must come from one of these. */
  allowedModels?: string[];
  /** Re-run a declined request on Anthropic's recommended fallback model. */
  refusalFallback?: boolean;
}

type SdkModule = typeof import('@anthropic-ai/sdk');

// Loaded once, on first use. Tests pass a module in directly.
let sdkPromise: Promise<SdkModule> | null = null;
function loadSdk(): Promise<SdkModule> {
  sdkPromise ??= import('@anthropic-ai/sdk');
  return sdkPromise;
}

export function createAnthropicFable(cfg: AnthropicFableConfig, deps: { sdk?: SdkModule } = {}): FableProvider {
  let client: Anthropic | null = null;
  let sdk: SdkModule | null = deps.sdk ?? null;

  async function getClient() {
    if (!sdk) {
      try {
        sdk = await loadSdk();
      } catch {
        throw providerUnavailable('fable', 'the Anthropic SDK is not installed on this deployment.');
      }
    }
    client ??= new sdk.default({ apiKey: cfg.apiKey, maxRetries: 2, timeout: cfg.timeoutMs });
    return { client, sdk };
  }

  return {
    info: {
      role: 'fable',
      vendor: 'anthropic',
      mode: 'real',
      model: cfg.model,
      available: true,
      price: cfg.price,
    },
    prepareImplement(req: ImplementRequest) {
      const prompt = implementPrompt(req);
      const inputTokens = approxTokens(prompt.system) + approxTokens(prompt.user) + approxTokens(JSON.stringify(EXECUTION_PLAN_SCHEMA));
      return {
        ceilingMinor: ceilingOf(cfg.price, inputTokens, cfg.maxOutputTokens),
        run: async (): Promise<ProviderResult> => {
          const { client, sdk } = await getClient();
          let message: Anthropic.Beta.BetaMessage;
          try {
            const stream = client.beta.messages.stream({
              model: cfg.model,
              max_tokens: cfg.maxOutputTokens,
              ...(cfg.refusalFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
              system: prompt.system,
              messages: [{ role: 'user', content: prompt.user }],
              output_config: {
                effort: cfg.effort,
                format: { type: 'json_schema', schema: EXECUTION_PLAN_SCHEMA },
              },
            });
            message = await stream.finalMessage();
          } catch (e) {
            throw mapSdkError(sdk, e);
          }

          const usage = {
            inputTokens:
              (message.usage.input_tokens ?? 0) +
              (message.usage.cache_creation_input_tokens ?? 0) +
              (message.usage.cache_read_input_tokens ?? 0),
            outputTokens: message.usage.output_tokens ?? 0,
          };
          const costMinor = costOf(cfg.price, usage);

          // Whatever routing happened, only an approved model's work is used.
          const allowed = cfg.allowedModels ?? [cfg.model];
          if (!allowed.includes(message.model)) {
            throw new BilledFailure(
              new DevError(ERR.PROVIDER_FAILED, `Fable's answer came from ${message.model}, which is not an approved model.`, { retryable: false }),
              costMinor
            );
          }

          if (message.stop_reason === 'refusal') {
            const category = message.stop_details?.category ?? 'unspecified';
            throw new BilledFailure(
              new DevError(ERR.PROVIDER_FAILED, `Fable declined to implement this (${category}).`, { retryable: false }),
              costMinor
            );
          }
          if (message.stop_reason === 'max_tokens') {
            throw new BilledFailure(
              new DevError(ERR.PROVIDER_OUTPUT, 'The implementation did not fit in the output limit.', { retryable: false }),
              costMinor
            );
          }

          const text = message.content
            .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');
          let raw: unknown;
          try {
            raw = parseModelJson(text);
          } catch (e) {
            throw new BilledFailure(e, costMinor);
          }
          return { raw, usage, costMinor, model: message.model };
        },
      };
    },
  };
}

/** Typed SDK errors onto retryable or not. Never the response body. */
function mapSdkError(sdk: SdkModule, e: unknown): DevError {
  if (e instanceof DevError) return e;
  const A = sdk.default;
  if (e instanceof A.APIConnectionError) {
    return new DevError(ERR.PROVIDER_FAILED, 'Fable could not be reached.', { httpStatus: 502, retryable: true });
  }
  if (e instanceof A.AuthenticationError || e instanceof A.PermissionDeniedError) {
    return providerUnavailable('fable', 'the configured credential was rejected.');
  }
  if (e instanceof A.APIError) {
    return providerHttpError('fable', e.status ?? 0, e.type ?? '');
  }
  return new DevError(ERR.PROVIDER_FAILED, 'Fable failed unexpectedly.', { httpStatus: 502, retryable: true });
}
