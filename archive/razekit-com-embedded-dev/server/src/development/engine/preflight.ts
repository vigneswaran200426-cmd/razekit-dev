// Pre-flight: what a build will probably need, before anything is created.
//
// The user commits to a hard budget, so the number they see first should be an
// informed one. This reads the request, sizes it, predicts the agent and its
// tools, names any external service it looks like it will want (each of which
// the user will be asked about before it is used), and estimates cost from the
// configured model prices.
//
// Deliberately deterministic and model-free. A pre-flight that itself calls a
// model costs money before the user has agreed to spend any, and gives two
// different answers to the same request.
import { agentForTaskType } from './agents.js';
import { validation } from './errors.js';
import { ceilingOf, toMajor, type ModelPrice } from './pricing.js';
import { agentToolset, type ToolAvailability } from './tools.js';
import { TASK_TYPES, type Preflight, type TaskType, type ToolName } from './types.js';

export interface PreflightPricing {
  astra: ModelPrice;
  fable: ModelPrice;
  currency: string;
}

// Things that, if a build needs them, cross a boundary the user must approve:
// they cost money outside the build, hold other people's data, or put
// something on the public internet.
export const EXTERNAL_SERVICES: { name: string; pattern: RegExp }[] = [
  { name: 'Payments', pattern: /\b(stripe|paypal|razorpay|checkout|payments?|subscriptions?|billing)\b/i },
  { name: 'Sign-in', pattern: /\b(log ?in|sign[- ]?in|sign[- ]?up|oauth|auth(entication)?|accounts?)\b/i },
  { name: 'Database', pattern: /\b(database|postgres|mysql|mongo|firebase|supabase|persist(ent)?|backend)\b/i },
  { name: 'Email', pattern: /\b(e-?mail|newsletter|mailchimp|smtp)\b/i },
  { name: 'Maps', pattern: /\b(google maps|mapbox|geolocation)\b/i },
  { name: 'Analytics', pattern: /\b(analytics|tracking pixel|google tag|mixpanel)\b/i },
  { name: 'AI model', pattern: /\b(chatbot|gpt|openai|llm|ai assistant)\b/i },
  { name: 'Multiplayer server', pattern: /\b(multiplayer|online play|leaderboard server|realtime server)\b/i },
  { name: 'Hosting', pattern: /\b(deploy|domain|hosting|publish online)\b/i },
];

// Features that make a build larger without crossing a boundary.
const FEATURE_WEIGHT: { pattern: RegExp; weight: number }[] = [
  { pattern: /\b(dashboard|admin|panel)\b/i, weight: 2 },
  { pattern: /\b(form|contact|validation)\b/i, weight: 1 },
  { pattern: /\b(gallery|carousel|slider|animation)\b/i, weight: 1 },
  { pattern: /\b(cart|shop|store|product)\b/i, weight: 2 },
  { pattern: /\b(chart|graph|report)\b/i, weight: 2 },
  { pattern: /\b(search|filter|sort)\b/i, weight: 1 },
  { pattern: /\b(drag|drop|editor|canvas)\b/i, weight: 2 },
  { pattern: /\b(3d|physics|procedural|level editor|ai opponent|enemies)\b/i, weight: 3 },
  { pattern: /\b(multiple (pages|screens|levels)|levels|screens|routing)\b/i, weight: 2 },
  { pattern: /\b(responsive|mobile|accessib)/i, weight: 1 },
  { pattern: /\b(dark mode|theme|i18n|translation)\b/i, weight: 1 },
];

// Tokens per phase, by complexity. Implement output dominates: it is the
// whole codebase written out. Iterations is how many implement → review
// cycles a build of that size usually takes.
const PROFILE = {
  low: { planOut: 3_000, implementOut: 12_000, reviewOut: 2_000, iterations: 2 },
  medium: { planOut: 5_000, implementOut: 24_000, reviewOut: 3_000, iterations: 3 },
  high: { planOut: 8_000, implementOut: 48_000, reviewOut: 4_000, iterations: 4 },
} as const;

export const MAX_REQUEST_CHARS = 8_000;
export const MAX_TITLE_CHARS = 120;

export interface PreflightInput {
  taskType: unknown;
  title?: unknown;
  originalRequest: unknown;
}

export function parseTaskType(value: unknown): TaskType {
  if (typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value)) return value as TaskType;
  throw validation(`taskType must be one of ${TASK_TYPES.join(', ')}.`);
}

export function parseRequest(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw validation('Describe what you want built.');
  if (text.length > MAX_REQUEST_CHARS) throw validation(`The request is limited to ${MAX_REQUEST_CHARS} characters.`);
  return text;
}

export function analyze(input: PreflightInput, pricing: PreflightPricing, availability: ToolAvailability): Preflight {
  const taskType = parseTaskType(input.taskType);
  const request = parseRequest(input.originalRequest);
  const title = typeof input.title === 'string' ? input.title.slice(0, MAX_TITLE_CHARS) : '';
  const text = `${title}\n${request}`;
  const agent = agentForTaskType(taskType);

  const externalServices = EXTERNAL_SERVICES.filter((s) => s.pattern.test(text)).map((s) => s.name);
  const words = text.split(/\s+/).filter(Boolean).length;
  let score = FEATURE_WEIGHT.reduce((sum, f) => sum + (f.pattern.test(text) ? f.weight : 0), 0);
  score += externalServices.length * 2;
  score += words > 250 ? 3 : words > 100 ? 2 : words > 40 ? 1 : 0;
  if (taskType === 'app') score += 1;
  if (taskType === 'game') score += 2;
  const complexity: Preflight['complexity'] = score >= 8 ? 'high' : score >= 4 ? 'medium' : 'low';

  const profile = PROFILE[complexity];
  const requestTokens = Math.ceil(text.length / 3);
  const planIn = 2_500 + requestTokens;
  const implementIn = 4_000 + requestTokens + profile.planOut;
  const reviewIn = 3_000 + profile.implementOut;

  const breakdown = [
    { phase: 'Planning', minor: ceilingOf(pricing.astra, planIn, profile.planOut) },
    { phase: 'Building', minor: profile.iterations * ceilingOf(pricing.fable, implementIn, profile.implementOut) },
    { phase: 'Reviewing', minor: profile.iterations * ceilingOf(pricing.astra, reviewIn, profile.reviewOut) },
  ];
  const subtotal = breakdown.reduce((sum, b) => sum + b.minor, 0);
  // Rounded up to a whole unit so the suggested ceiling is a number a person
  // would type, and never below one unit so the form always has a usable value.
  const estimatedBudgetMinor = Math.max(100, Math.ceil(subtotal / 100) * 100);

  const { unavailable } = agentToolset(agent, availability);
  const predictedTools: ToolName[] = [...agent.tools];

  const warnings: string[] = [];
  if (externalServices.length) {
    warnings.push('This looks like it needs services outside the build. You will be asked before any of them is used.');
  }
  for (const u of unavailable) warnings.push(`${u.tool}: ${u.reason}`);

  return {
    taskType,
    predictedAgentType: agent.type,
    complexity,
    predictedTools,
    unavailableTools: unavailable,
    externalServices,
    estimatedBudget: toMajor(estimatedBudgetMinor),
    estimatedBudgetMinor,
    breakdown,
    currency: pricing.currency,
    warnings,
  };
}

/**
 * What one more implement → review cycle is likely to cost at this size. Used
 * to tell the user, before they approve a change, whether it fits the budget.
 */
export function iterationCostMinor(complexity: Preflight['complexity'], pricing: PreflightPricing): number {
  const profile = PROFILE[complexity];
  return (
    ceilingOf(pricing.fable, 6_000 + profile.planOut, profile.implementOut) +
    ceilingOf(pricing.astra, 3_000 + profile.implementOut, profile.reviewOut)
  );
}
