// The two model roles, and the contract every adapter for them keeps.
//
//   Astra  plans and reviews   (OpenAI in production)
//   Fable  implements          (Anthropic in production)
//
// A call is prepared before it is made. Preparing builds the exact prompt and
// works out the most that prompt can cost; the governor reserves that amount,
// and only then is the call run. So the ceiling is computed from the real
// request rather than guessed, and a call that cannot fit never leaves the
// building.
//
// An adapter that is not configured says so, with the reason, every time it
// is asked. It never falls back to something else and never pretends: a build
// that needs a real model and has none stops and says why.
import { DevError, ERR } from './errors.js';
import type { ImplementRequest, PlanRequest, ReviewRequest, AnalysisRequest } from './prompts.js';
import type { ModelPrice, Usage } from './pricing.js';

export interface ProviderInfo {
  role: 'astra' | 'fable';
  vendor: 'openai' | 'anthropic' | 'razekit';
  mode: 'real' | 'deterministic' | 'unavailable';
  model: string;
  available: boolean;
  reason?: string;
  price: ModelPrice;
}

export interface ProviderResult {
  /** Parsed JSON, not yet validated. Validation is the caller's job. */
  raw: unknown;
  usage: Usage;
  costMinor: number;
  model: string;
}

export interface PreparedCall {
  ceilingMinor: number;
  run(): Promise<ProviderResult>;
}

export interface AstraProvider {
  info: ProviderInfo;
  preparePlan(req: PlanRequest): PreparedCall;
  prepareReview(req: ReviewRequest): PreparedCall;
  /**
   * Structured analysis of RazeKit DEV's own operation. Only a real model has
   * it: nothing deterministic may stand in for reasoning about the platform.
   */
  prepareAnalysis?(req: AnalysisRequest): PreparedCall;
}

export interface FableProvider {
  info: ProviderInfo;
  prepareImplement(req: ImplementRequest): PreparedCall;
}

export interface ProviderSet {
  astra: AstraProvider;
  fable: FableProvider;
  mode: 'real' | 'deterministic' | 'unavailable';
}

export function providerUnavailable(role: 'astra' | 'fable', reason: string): DevError {
  return new DevError(ERR.PROVIDER_UNAVAILABLE, `${role === 'astra' ? 'Astra' : 'Fable'} is not available: ${reason}`, {
    httpStatus: 503,
    retryable: false,
  });
}

const ZERO: ModelPrice = { inputMinorPerMTok: 0, outputMinorPerMTok: 0 };

export function unavailableAstra(reason: string): AstraProvider {
  const fail = () => {
    throw providerUnavailable('astra', reason);
  };
  return {
    info: { role: 'astra', vendor: 'razekit', mode: 'unavailable', model: 'none', available: false, reason, price: ZERO },
    preparePlan: fail,
    prepareReview: fail,
  };
}

export function unavailableFable(reason: string): FableProvider {
  return {
    info: { role: 'fable', vendor: 'razekit', mode: 'unavailable', model: 'none', available: false, reason, price: ZERO },
    prepareImplement: () => {
      throw providerUnavailable('fable', reason);
    },
  };
}

/** Maps an HTTP status from a provider onto whether trying again can help. */
export function providerHttpError(role: 'astra' | 'fable', status: number, detail: string): DevError {
  const retryable = status === 408 || status === 409 || status === 429 || status >= 500;
  const name = role === 'astra' ? 'Astra' : 'Fable';
  // The provider's own error type and status only. A response body can echo
  // the request back, and the request contains the customer's code.
  return new DevError(ERR.PROVIDER_FAILED, `${name} request failed (${status}${detail ? `: ${detail}` : ''}).`, {
    httpStatus: 502,
    retryable,
  });
}
