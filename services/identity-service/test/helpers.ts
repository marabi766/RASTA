import { runWithContext, type RequestContext } from '@rasta/nest-common';
import { ulid } from 'ulid';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * The minimum scaffolding the ADR-051 B3 integration evidence needs.
 *
 * Deliberately thin, and deliberately new: this service had no integration
 * suite, and B3 requires per-service evidence that a real domain operation
 * commits a correctly sequenced outbox row. Building a full harness is a
 * larger change than B3; this provides exactly what the sequencing evidence
 * needs and nothing else.
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_IDENTITY;
  if (!url) {
    throw new Error(
      'DATABASE_URL_IDENTITY is not set. These tests run against a real PostgreSQL; ' +
        'start it with `pnpm infra:up` and copy .env.example to .env.',
    );
  }
  return url;
}

export function newPrisma(): PrismaService {
  return new PrismaService(databaseUrl());
}

export function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

export function tenants() {
  const suffix = ulid().slice(-10);
  return { a: `ORG-ITEST-A-${suffix}`, b: `ORG-ITEST-B-${suffix}` };
}

export interface ActorOptions {
  organizationId: string;
  userId?: string;
  roles?: string[];
  authType?: 'USER' | 'SERVICE';
}

/** Runs `fn` as a user acting for an organization. */
export function asActor<T>(options: ActorOptions, fn: () => Promise<T>): Promise<T> {
  const context: RequestContext = {
    correlationId: `COR-ITEST-${ulid().slice(-8)}`,
    requestId: `REQ-ITEST-${ulid().slice(-8)}`,
    organizationId: options.organizationId,
    userId: options.userId ?? 'USR-ITEST',
    roles: options.roles ?? ['PLATFORM_OPERATOR'],
    authType: options.authType ?? 'USER',
    startedAt: Date.now(),
  };
  return runWithContext(context, fn);
}
