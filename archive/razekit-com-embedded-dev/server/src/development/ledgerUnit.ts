// The production unit of work for DEV money: one transaction on the platform
// database, serialised per user.
//
// Why an advisory lock and not SERIALIZABLE: the thing that must not race is
// two DEV operations for the same user reading the same development balance.
// A per-user lock serialises exactly those and nothing else. SERIALIZABLE
// would also make DEV postings conflict with unrelated marketplace postings on
// the shared platform accounts — and a contest-funding verification failing
// because someone bought development budget at the same moment is precisely
// the kind of marketplace regression DEV must never cause.
import { prisma } from '../db.js';
import { serviceClient } from '../entities/service.js';
import type { LedgerUnitOfWork } from './funding.js';

export const ledgerUnitOfWork: LedgerUnitOfWork = (userId, fn) =>
  prisma.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext($1))', `razekit-dev-funding:${userId}`);
      return fn(serviceClient(tx));
    },
    { timeout: 20_000, maxWait: 10_000 }
  );
