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

/**
 * Tags every identifier one test run creates, so a suite that shares
 * infrastructure with other runs (a developer's `pnpm infra:up`, another
 * suite's Kafka consumer group) can tell its own rows and messages apart.
 * Not currently read by a cleanup routine — this service's integration
 * suites tag rows for grep-ability in a shared log, not for automated
 * teardown.
 */
export const RUN_TAG = ulid().slice(-10);

/**
 * Waits for `check` to become truthy, or gives up with a readable failure.
 *
 * Identity-owned rather than imported from another service: AGENTS.md A-02
 * forbids a service reaching into another's `src/**` or `test/**`, and a
 * generic poll is cheap enough to keep on each side of that boundary rather
 * than share.
 */
export async function waitFor<T>(
  description: string,
  check: () => Promise<T | null | undefined>,
  timeoutMs = 60_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}` +
      (last ? `; last error: ${String(last)}` : ''),
  );
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
