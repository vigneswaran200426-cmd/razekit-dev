// Errors that mean something.
//
// Every failure in RazeKit DEV answers two questions the caller needs before it
// can do the right thing: what should the user be told (httpStatus + message),
// and is trying again ever going to help (retryable)?
//
// The second one matters more than it looks. A build that hits its own budget
// ceiling, exhausts its repair attempts or is refused a tool will hit the same
// wall on every retry — retrying it only spends time and, with a real provider,
// money. Only failures outside our own limits (a provider hiccup, a worker that
// died mid-run) are worth another go.

export class DevError extends Error {
  code: string;
  httpStatus: number;
  retryable: boolean;
  constructor(code: string, message: string, { httpStatus = 400, retryable = false } = {}) {
    super(message);
    this.name = 'DevError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

export const ERR = {
  VALIDATION: 'DEV_VALIDATION',
  NOT_FOUND: 'DEV_NOT_FOUND',
  CONFLICT: 'DEV_CONFLICT',
  STATE: 'DEV_ILLEGAL_TRANSITION',
  AUTHORIZATION_REQUIRED: 'DEV_AUTHORIZATION_REQUIRED',
  BUDGET_EXCEEDED: 'DEV_BUDGET_EXCEEDED',
  INSUFFICIENT_FUNDS: 'DEV_INSUFFICIENT_FUNDS',
  CAPTURE: 'DEV_CAPTURE_INVALID',
  TOOL_DENIED: 'DEV_TOOL_DENIED',
  TOOL_UNAVAILABLE: 'DEV_TOOL_UNAVAILABLE',
  PATH: 'DEV_UNSAFE_PATH',
  PLAN_INVALID: 'DEV_PLAN_INVALID',
  PROVIDER_UNAVAILABLE: 'DEV_PROVIDER_UNAVAILABLE',
  PROVIDER_FAILED: 'DEV_PROVIDER_FAILED',
  PROVIDER_OUTPUT: 'DEV_PROVIDER_OUTPUT_INVALID',
  RUNTIME_UNAVAILABLE: 'DEV_RUNTIME_UNAVAILABLE',
  ATTEMPTS_EXHAUSTED: 'DEV_ATTEMPTS_EXHAUSTED',
  LEASE_LOST: 'DEV_LEASE_LOST',
  PAUSED: 'DEV_EXECUTION_PAUSED',
  NOT_CONFIGURED: 'DEV_NOT_CONFIGURED',
  DELIVERY: 'DEV_DELIVERY_FAILED',
} as const;

export const validation = (message: string) => new DevError(ERR.VALIDATION, message, { httpStatus: 400 });
export const notFound = (what = 'Build') => new DevError(ERR.NOT_FOUND, `${what} not found`, { httpStatus: 404 });
export const conflict = (message: string) => new DevError(ERR.CONFLICT, message, { httpStatus: 409, retryable: true });
