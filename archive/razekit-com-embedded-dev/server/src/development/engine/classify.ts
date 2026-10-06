// What to do with something the user says mid-build.
//
//   refinement    in scope: "make the hero dark blue", "call it Nimbus".
//                 Applied at the next implement, no question asked.
//   boundary      crosses a line the user must consciously approve: an
//                 external service, other people's data, the public internet,
//                 a credential. Held as a decision; nothing happens until they
//                 say yes.
//   out_of_scope  a different build altogether ("actually, make it a game").
//                 Held as a decision too, because approving it throws away
//                 most of the work and money spent so far.
//
// One classifier, used by the API and nothing else, so the same sentence always
// gets the same treatment. The text is the user's own and is never executed or
// interpreted beyond this; it reaches a model only fenced as data.
import { validation } from './errors.js';
import { EXTERNAL_SERVICES } from './preflight.js';
import type { DevChange, TaskType } from './types.js';

export const MAX_COMMAND_CHARS = 2_000;

const SENSITIVE: { pattern: RegExp; reason: string }[] = [
  { pattern: /\b(api[ -]?keys?|secret|credential|password|token)\b/i, reason: 'It involves credentials.' },
  { pattern: /\b(delete|wipe|drop) (all|every|the) (data|users?|records?)\b/i, reason: 'It would destroy data.' },
  { pattern: /\b(scrape|crawl|download from)\b/i, reason: 'It reaches out to other websites.' },
  { pattern: /\b(personal data|user data|pii|collect emails?)\b/i, reason: 'It handles personal data.' },
];

const TYPE_WORDS: Record<TaskType, RegExp> = {
  game: /\b(make|turn|change)\b[^.]{0,30}\b(into |to )?(an? )?(game|platformer|shooter|puzzle game)\b/i,
  website: /\b(make|turn|change)\b[^.]{0,30}\b(into |to )?(an? )?(website|landing page|web ?site)\b/i,
  app: /\b(make|turn|change)\b[^.]{0,30}\b(into |to )?(an? )?(app|application|dashboard)\b/i,
};

export interface Classification {
  classification: DevChange['classification'];
  reason: string;
}

export function parseCommand(content: unknown): string {
  const text = typeof content === 'string' ? content.trim() : '';
  if (!text) throw validation('Say what you would like changed.');
  if (text.length > MAX_COMMAND_CHARS) throw validation(`A message is limited to ${MAX_COMMAND_CHARS} characters.`);
  return text;
}

export function classifyChange(content: string, taskType: TaskType): Classification {
  for (const [type, pattern] of Object.entries(TYPE_WORDS) as [TaskType, RegExp][]) {
    if (type !== taskType && pattern.test(content)) {
      return {
        classification: 'out_of_scope',
        reason: `This build is a ${taskType}; turning it into a ${type} is a different build and would replace most of what has been done.`,
      };
    }
  }
  const services = EXTERNAL_SERVICES.filter((s) => s.pattern.test(content)).map((s) => s.name);
  if (services.length) {
    return {
      classification: 'boundary',
      reason: `This needs something outside the build (${services.join(', ')}). It will only be added if you approve it.`,
    };
  }
  const sensitive = SENSITIVE.find((s) => s.pattern.test(content));
  if (sensitive) return { classification: 'boundary', reason: `${sensitive.reason} It will only go ahead if you approve it.` };
  return { classification: 'refinement', reason: 'In scope for this build, so it is applied at the next step.' };
}

/** The money side of a decision: what the build would need to carry on. */
export function budgetSnapshot(
  task: { maxBudgetMinor: number; spentMinor: number; reservedMinor: number },
  projectedMinor: number
): DevChange['budgetSnapshot'] {
  const remaining = Math.max(0, task.maxBudgetMinor - task.spentMinor - task.reservedMinor);
  const neededTotal = task.spentMinor + task.reservedMinor + Math.max(0, projectedMinor);
  return {
    projectedSpend: Math.ceil(neededTotal) / 100,
    projectedSpendMinor: neededTotal,
    remainingMinor: remaining,
    withinBudget: projectedMinor <= remaining,
  };
}
