// What a model call can cost, in minor units.
//
// Prices are per million tokens, in minor units of the task currency (cents
// for USD). Every calculation rounds UP: an estimate that rounds down is a
// reservation that can be exceeded, and a reservation that can be exceeded is
// not a ceiling.

export interface ModelPrice {
  inputMinorPerMTok: number;
  outputMinorPerMTok: number;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

const MTOK = 1_000_000;

/** The cost of a completed call from its reported usage. */
export function costOf(price: ModelPrice, usage: Usage): number {
  const input = Math.max(0, Math.floor(Number(usage.inputTokens) || 0));
  const output = Math.max(0, Math.floor(Number(usage.outputTokens) || 0));
  return Math.ceil((input * price.inputMinorPerMTok + output * price.outputMinorPerMTok) / MTOK);
}

/**
 * The most a call can cost: its input, plus every output token it is allowed
 * to produce. This is what the governor reserves before the call is made, and
 * because max_tokens is enforced by the provider the bill cannot exceed it.
 */
export function ceilingOf(price: ModelPrice, inputTokens: number, maxOutputTokens: number): number {
  return costOf(price, { inputTokens, outputTokens: maxOutputTokens });
}

/**
 * A conservative token count for text we are about to send.
 *
 * Three characters per token over-counts English and code for every current
 * tokenizer, which is the direction we want for a reservation. This is never
 * used to bill anyone — only to size an upper bound.
 */
export function approxTokens(text: string): number {
  return Math.ceil(String(text ?? '').length / 3) + 16;
}

export const toMinor = (major: number): number => Math.round(Number(major) * 100);
export const toMajor = (minor: number): number => Math.round(Number(minor)) / 100;
