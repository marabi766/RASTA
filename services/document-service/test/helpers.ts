import { ulid } from 'ulid';
import { runWithContext, runUnscoped, type RequestContext } from '@rasta/nest-common';
import { PrismaService } from '../src/prisma/prisma.service';
import { EventPublisher } from '../src/events/publisher';
import { DocumentRepository } from '../src/document/document.repository';
import { DocumentService } from '../src/document/document.service';
import { S3ObjectStorage } from '../src/storage/s3.storage';
import { NoOpMalwareScanner } from '../src/scanning/stub.scanner';
import { loadDocumentEnv, type DocumentEnv } from '../src/config/env';
import type { ObjectStorage } from '../src/storage/storage.port';
import type { MalwareScanner } from '../src/scanning/scanner.port';

/**
 * Scaffolding for the integration tests.
 *
 * Deliberately thin. These suites exist to touch a real PostgreSQL **and a
 * real MinIO** — the CHECK constraints, the conditional updates and the
 * signed-URL behaviour exist only in those two systems, so anything that hides
 * either behind a helper defeats the point.
 */

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL ?? process.env.DATABASE_URL_DOCUMENT;
  if (!url) {
    throw new Error(
      'DATABASE_URL_DOCUMENT is not set. These tests run against a real PostgreSQL; ' +
        'start it with `pnpm infra:up` and copy .env.example to .env.',
    );
  }
  return url;
}

export function newPrisma(): PrismaService {
  return new PrismaService(databaseUrl());
}

export function testEnv(overrides: Record<string, string> = {}): DocumentEnv {
  return loadDocumentEnv({
    ...process.env,
    DATABASE_URL: databaseUrl(),

    // Storage is real. These are the same values `.env.example` carries for
    // local MinIO, and the suites genuinely upload to and read from it.
    S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    S3_REGION: process.env.S3_REGION ?? 'us-east-1',
    S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'rasta_minio_admin',
    S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'rasta_minio_dev_password',
    S3_BUCKET_DOCUMENTS: process.env.S3_BUCKET_DOCUMENTS ?? 'rasta-documents',
    S3_FORCE_PATH_STYLE: 'true',

    // Never verified by these suites: they call the domain with an explicit
    // `RequestContext`, so no OIDC discovery and no internal token is ever
    // exchanged. The schema demands them because the running service needs
    // them, and turbo passes only its declared env list through. Throwaway
    // values, never used to sign or verify anything.
    OIDC_ISSUER_URL: process.env.OIDC_ISSUER_URL ?? 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI:
      process.env.OIDC_JWKS_URI ??
      'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: process.env.OIDC_AUDIENCE ?? 'rasta-api',
    INTERNAL_TOKEN_SECRET:
      process.env.INTERNAL_TOKEN_SECRET ?? 'integration_suite_unused_secret_32_chars',

    ...overrides,
  });
}

export function newStorage(env: DocumentEnv): S3ObjectStorage {
  return new S3ObjectStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET_DOCUMENTS,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });
}

export interface Wiring {
  prisma: PrismaService;
  env: DocumentEnv;
  storage: ObjectStorage;
  scanner: MalwareScanner;
  events: EventPublisher;
  repository: DocumentRepository;
  documents: DocumentService;
}

/**
 * Wires the domain by hand.
 *
 * Not through Nest: booting the container would start the outbox relay, which
 * drains every pending row and makes the outbox assertions in these suites
 * depend on a timer. economic-service learned that one under `--coverage`.
 */
export function wire(
  prisma: PrismaService,
  options: { env?: DocumentEnv; scanner?: MalwareScanner } = {},
): Wiring {
  const env = options.env ?? testEnv();
  const storage = newStorage(env);
  const scanner = options.scanner ?? new NoOpMalwareScanner();
  const events = new EventPublisher(env);
  const repository = new DocumentRepository(prisma);
  const documents = new DocumentService(prisma, repository, events, env, storage, scanner);

  return { prisma, env, storage, scanner, events, repository, documents };
}

/**
 * Two organizations, generated fresh per run.
 *
 * Generated rather than fixed so a re-run cannot collide with rows an earlier
 * run left behind, and so the isolation tests prove isolation between two
 * tenants that genuinely exist rather than between a tenant and an empty set.
 */
export function tenants() {
  const suffix = ulid().slice(-10);
  return {
    a: `ORG-DOCTEST-A-${suffix}`,
    b: `ORG-DOCTEST-B-${suffix}`,
    platform: `ORG-DOCTEST-PLATFORM-${suffix}`,
  };
}

export interface ActorOptions {
  organizationId: string;
  userId?: string;
  roles?: string[];
  authType?: 'USER' | 'SERVICE';
  callerService?: string;
}

/**
 * Runs `fn` as a user acting for an organization.
 *
 * Wrapped in `async () => fn()` rather than passed straight through, and the
 * difference is the whole test: a Prisma query is lazy, so a non-async arrow
 * would have its `.then` happen on the outer `await`, after this context has
 * closed, and the query would execute with no tenant at all.
 */
export function asActor<T>(options: ActorOptions, fn: () => Promise<T>): Promise<T> {
  const context: RequestContext = {
    correlationId: `itest-${ulid()}`,
    requestId: `itest-${ulid()}`,
    organizationId: options.organizationId,
    userId: options.userId ?? `USR-ITEST-${ulid().slice(-8)}`,
    roles: options.roles ?? ['ORGANIZATION_ADMIN'],
    authType: options.authType ?? 'USER',
    startedAt: Date.now(),
    ...(options.callerService ? { callerService: options.callerService } : {}),
  };

  return runWithContext(context, async () => fn());
}

export function id(prefix: string): string {
  return `${prefix}_${ulid()}`;
}

/** The outbox rows one organization produced, oldest first. */
export function outboxFor(prisma: PrismaService, organizationId: string) {
  return runUnscoped('the outbox audit reads platform plumbing', () =>
    prisma.client.outboxMessage.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

/**
 * Removes everything these organizations created, including their objects.
 *
 * The object cleanup matters more here than the row cleanup: a suite that left
 * objects behind would slowly fill the developer's bucket, and the orphans
 * would be indistinguishable from the ones ADR-014 warns about in production.
 */
export async function cleanup(
  prisma: PrismaService,
  organizationIds: string[],
  storage?: ObjectStorage,
): Promise<void> {
  if (organizationIds.length === 0) return;

  await runUnscoped('the suite removes the rows it created', async () => {
    const documents = await prisma.client.document.findMany({
      where: { organizationId: { in: organizationIds } },
      select: { objectKey: true },
    });
    const intents = await prisma.client.uploadIntent.findMany({
      where: { organizationId: { in: organizationIds } },
      select: { objectKey: true },
    });

    await prisma.client.accessGrant.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    await prisma.client.document.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    await prisma.client.uploadIntent.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });
    await prisma.client.outboxMessage.deleteMany({
      where: { organizationId: { in: organizationIds } },
    });

    if (storage) {
      const keys = new Set([
        ...documents.map((row) => row.objectKey),
        ...intents.map((row) => row.objectKey),
      ]);
      // Best effort: an object that was never uploaded has nothing to remove,
      // and a failure here must not fail a suite that otherwise passed.
      await Promise.all([...keys].map((key) => storage.remove(key).catch(() => undefined)));
    }
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Real files, built byte by byte.
 *
 * Not read from disk: a fixture file in the repository is a file somebody has
 * to trust, and these need to be *exactly* what they claim so a magic-number
 * test proves something. Each is the smallest thing that is genuinely of its
 * format.
 */
export const FIXTURES = {
  pdf(): Buffer {
    // A minimal but structurally real PDF: header, one object, trailer.
    return Buffer.from(
      '%PDF-1.4\n' +
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n' +
        'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
      'latin1',
    );
  },

  png(): Buffer {
    // PNG signature plus an IHDR chunk — enough to be identified as a PNG and
    // nothing more.
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]),
      Buffer.alloc(16, 0x01),
    ]);
  },

  jpeg(): Buffer {
    return Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.from('JFIF\0', 'latin1'),
      Buffer.alloc(32, 0x02),
    ]);
  },

  /** An HTML page — the thing that must never be stored or served. */
  html(): Buffer {
    return Buffer.from(
      '<!DOCTYPE html><html><body><script>fetch("/steal")</script></body></html>',
      'latin1',
    );
  },

  /** A Windows executable header. */
  executable(): Buffer {
    return Buffer.concat([Buffer.from([0x4d, 0x5a, 0x90, 0x00]), Buffer.alloc(60, 0x00)]);
  },
} as const;

/**
 * Uploads bytes to a signed URL, exactly as a browser would.
 *
 * `fetch` rather than the S3 client on purpose: this is the step that in
 * production happens in the client and never touches this service, so the test
 * performs it the same way — an ordinary HTTP PUT to a URL, with no
 * credentials of its own.
 */
export async function putToSignedUrl(
  uploadUrl: string,
  body: Buffer,
  contentType: string,
): Promise<number> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: new Uint8Array(body),
  });
  return response.status;
}

/** Downloads from a signed URL and returns the bytes. */
export async function getFromSignedUrl(downloadUrl: string): Promise<{
  status: number;
  body: Buffer;
  contentType: string | null;
  contentDisposition: string | null;
}> {
  const response = await fetch(downloadUrl);
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    body: buffer,
    contentType: response.headers.get('content-type'),
    contentDisposition: response.headers.get('content-disposition'),
  };
}
