// Telling a build's owner when something needs them or has happened, by email,
// through the platform's existing email integration (Resend in production).
//
// Only moments that matter to a person are sent: a decision is needed, the
// build finished, it failed, it was delivered. Never a step, a retry or a
// heartbeat.
//
// Each notification is claimed in the DEV store before it is sent, so however
// many workers or retries reach the same moment, one email goes out. Email is
// secondary: a failed send is recorded and never stops or fails a build.
import type { DevTask } from './engine/types.js';
import type { DevStore } from './store/types.js';

export type NotificationKind = 'decision' | 'completed' | 'failed' | 'delivered';

export interface DevNotifier {
  notify(task: DevTask, kind: NotificationKind): Promise<void>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export function createEmailNotifier(deps: {
  store: DevStore;
  send: (m: EmailMessage) => Promise<unknown>;
  webBaseUrl: string;
  now?: () => Date;
  report?: (error: unknown, context: Record<string, unknown>) => void;
}): DevNotifier {
  return {
    async notify(task, kind) {
      const to = task.notifyEmail;
      if (!to) return;
      const discriminator = kind === 'decision' ? task.decision?.changeId ?? String(task.revision) : kind === 'delivered' ? task.delivery?.pullRequest.url ?? '' : '';
      const key = `notify:${task.id}:${kind}:${discriminator}`;
      const at = (deps.now?.() ?? new Date()).toISOString();
      try {
        if (!(await deps.store.claimOnce(key, { at }))) return;
        const link = `${deps.webBaseUrl.replace(/\/$/, '')}/development/${task.id}`;
        await deps.send({ to, ...message(task, kind, link) });
      } catch (e) {
        deps.report?.(e, { where: 'dev.notify', taskId: task.id, kind });
      }
    },
  };
}

function message(task: DevTask, kind: NotificationKind, link: string): { subject: string; body: string } {
  const title = task.title;
  switch (kind) {
    case 'decision':
      return {
        subject: `RazeKit DEV: "${title}" needs your decision`,
        body: `Your build "${title}" has paused and is waiting for you.\n\n${task.decision?.message ?? ''}\n\nNothing more is spent until you answer: ${link}`,
      };
    case 'completed':
      return {
        subject: `RazeKit DEV: "${title}" is ready`,
        body: `Your build "${title}" was built, tested and verified.\n\nDownload it or deliver it: ${link}`,
      };
    case 'failed':
      return {
        subject: `RazeKit DEV: "${title}" could not be finished`,
        body: `Your build "${title}" stopped: ${task.failure?.message ?? 'see the build page for details.'}\n\nUnused budget is returned as development credit. Details: ${link}`,
      };
    case 'delivered':
      return {
        subject: `RazeKit DEV: "${title}" was delivered to GitHub`,
        body: `A draft pull request is open: ${task.delivery?.pullRequest.url ?? link}\n\nBuild: ${link}`,
      };
  }
}
