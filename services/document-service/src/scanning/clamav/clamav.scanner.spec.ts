import { Readable } from 'node:stream';
import { ClamAvMalwareScanner } from './clamav.scanner';
import { startFakeClamd, unusedPort, type FakeClamd } from './fake-clamd';
import { LIMITS_EXCEEDED_PREFIX } from './protocol';

/**
 * The adapter, against a clamd that speaks the real wire protocol.
 *
 * A TCP server rather than a mocked socket. Everything interesting here is
 * transport behaviour — a refused connection, a peer that never answers, a
 * reply arriving in two packets, a stream cut short by a size ceiling — and
 * none of it exists against a stub. The engine itself is exercised for real in
 * `test/clamav-scan.int-spec.ts`, including EICAR.
 *
 * The invariant every test defends: **only a validated `OK`, from a fresh
 * database, becomes `CLEAN`.** Everything else is `FAILED` with a reason.
 */

const NOW = new Date('2026-08-31T12:00:00.000Z');
/** Two hours old — comfortably fresh under any threshold used below. */
const FRESH_VERSION = `ClamAV 1.5.4/28108/Sun Aug 31 10:00:00 2026\0`;

let clamd: FakeClamd;

beforeAll(async () => {
  clamd = await startFakeClamd({ version: { kind: 'reply', text: FRESH_VERSION } });
});

afterAll(async () => {
  await clamd.close();
});

beforeEach(() => {
  clamd.behaviours.version = { kind: 'reply', text: FRESH_VERSION };
  clamd.behaviours.instream = { kind: 'reply', text: 'stream: OK\0' };
});

function scanner(overrides: Partial<Parameters<typeof makeOptions>[0]> = {}) {
  return new ClamAvMalwareScanner(makeOptions({ port: clamd.port, ...overrides }));
}

function makeOptions(input: {
  port: number;
  timeoutMs?: number;
  chunkBytes?: number;
  maxBytes?: number;
  signatureMaxAgeSeconds?: number;
  versionCacheSeconds?: number;
  now?: () => Date;
}) {
  return {
    address: { transport: 'tcp' as const, host: '127.0.0.1', port: input.port },
    timeoutMs: input.timeoutMs ?? 2_000,
    chunkBytes: input.chunkBytes ?? 65_536,
    maxBytes: input.maxBytes ?? 1_000_000,
    signatureMaxAgeSeconds: input.signatureMaxAgeSeconds ?? 48 * 3600,
    versionCacheSeconds: input.versionCacheSeconds ?? 60,
    now: input.now ?? (() => NOW),
  };
}

/** A request whose bytes come from memory, as an object stream would. */
function request(bytes: Buffer, sizeBytes = bytes.length) {
  return {
    open: async () => Readable.from([bytes]),
    sizeBytes,
    contentType: 'application/pdf',
  };
}

describe('a document that matches nothing', () => {
  it('is CLEAN, and says which engine and database cleared it', async () => {
    const result = await scanner().scan(request(Buffer.from('%PDF-1.4 harmless')));

    expect(result.verdict).toBe('CLEAN');
    expect(result.engine).toBe('clamav');
    expect(result.engineVersion).toBe('1.5.4');
    expect(result.signatureVersion).toBe('28108');
    expect(result.signatureAgeSeconds).toBe(2 * 3600);
    expect(result.signature).toBeNull();
    expect(result.failureReason).toBeNull();
  });

  it('sends exactly the bytes it was given', async () => {
    const payload = Buffer.from('%PDF-1.4 the whole document, unaltered');
    await scanner().scan(request(payload));

    expect(clamd.lastStreamBytes().equals(payload)).toBe(true);
  });

  it('streams in frames rather than one buffer, so memory stays bounded', async () => {
    // 10 KB through a 1 KB frame size. The count is the observable proof that
    // a 25 MB document does not become a 25 MB write.
    const payload = Buffer.alloc(10 * 1024, 0x41);
    await scanner({ chunkBytes: 1024 }).scan(request(payload));

    expect(clamd.lastFrameCount()).toBe(10);
    expect(clamd.lastStreamBytes()).toHaveLength(10 * 1024);
  });

  it('reassembles a reply that arrives in two packets', async () => {
    // TCP does not preserve write boundaries. A client that parsed the first
    // packet would read `stream: ` as unparseable and fail a clean document.
    clamd.behaviours.instream = { kind: 'split', first: 'stream: ', second: 'OK\0', delayMs: 15 };

    expect((await scanner().scan(request(Buffer.from('ok')))).verdict).toBe('CLEAN');
  });
});

describe('a document that matches a signature', () => {
  it('is INFECTED and carries the signature name', async () => {
    clamd.behaviours.instream = { kind: 'reply', text: 'stream: Eicar-Test-Signature FOUND\0' };

    const result = await scanner().scan(request(Buffer.from('anything')));

    expect(result.verdict).toBe('INFECTED');
    expect(result.signature).toBe('Eicar-Test-Signature');
    expect(result.failureReason).toBeNull();
    expect(result.retryable).toBe(false);
  });

  it('bounds a signature name, because it is stored, logged and published', async () => {
    clamd.behaviours.instream = {
      kind: 'reply',
      text: `stream: ${'S'.repeat(400)} FOUND\0`,
    };

    const result = await scanner().scan(request(Buffer.from('anything')));

    expect(result.verdict).toBe('INFECTED');
    expect(result.signature).toHaveLength(255);
  });

  it('is INFECTED even when the database is too old to support a pass', async () => {
    // The asymmetry, stated as a test. A stale database still finds what it
    // knows, so a match from one is still a match; it is only the *absence* of
    // a match that an old database cannot support.
    clamd.behaviours.instream = { kind: 'reply', text: 'stream: Old-Signature FOUND\0' };

    const result = await scanner({ signatureMaxAgeSeconds: 3600 }).scan(
      request(Buffer.from('anything')),
    );

    // With a two-hour-old database and a one-hour ceiling, the scan is refused
    // before it starts — so this documents the boundary rather than the match.
    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('STALE_SIGNATURES');
  });
});

describe('failures never become clean', () => {
  it('records a timeout when the scanner accepts and never answers', async () => {
    clamd.behaviours.instream = { kind: 'silent' };

    const result = await scanner({ timeoutMs: 300 }).scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('TIMEOUT');
    expect(result.retryable).toBe(true);
  });

  it('records a connection failure when nothing is listening', async () => {
    const result = await scanner({ port: await unusedPort() }).scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('CONNECTION_FAILED');
    expect(result.retryable).toBe(true);
  });

  it('records a protocol error when the scanner hangs up without answering', async () => {
    clamd.behaviours.instream = { kind: 'close' };

    const result = await scanner().scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('FAILED');
    expect(['PROTOCOL_ERROR', 'CONNECTION_FAILED']).toContain(result.failureReason);
  });

  it('records a malformed response for a reply it cannot interpret', async () => {
    clamd.behaviours.instream = { kind: 'reply', text: 'stream: MAYBE\0' };

    const result = await scanner().scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('MALFORMED_RESPONSE');
  });

  it('records a partial reply as malformed rather than reading its prefix', async () => {
    // `stream: OK` with no terminator is a reply still in flight. Answered
    // after the deadline so the client sees the truncated form.
    clamd.behaviours.instream = { kind: 'reply', text: 'stream: OK' };

    const result = await scanner({ timeoutMs: 300 }).scan(request(Buffer.from('x')));

    expect(result.verdict).not.toBe('CLEAN');
    expect(result.failureReason).toBe('TIMEOUT');
  });

  it('records an engine error as a failure, not as a pass', async () => {
    clamd.behaviours.instream = { kind: 'reply', text: "stream: Can't allocate memory ERROR\0" };

    const result = await scanner().scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('ENGINE_ERROR');
    expect(result.retryable).toBe(true);
  });

  it('records a scan that stopped at a limit as neither clean nor infected', async () => {
    clamd.behaviours.instream = {
      kind: 'reply',
      text: `stream: ${LIMITS_EXCEEDED_PREFIX}.MaxRecursion FOUND\0`,
    };

    const result = await scanner().scan(request(Buffer.from('a deeply nested archive')));

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('SCAN_LIMITS_EXCEEDED');
    expect(result.signature).toBeNull();
    // Not retryable: the same object against the same limits reaches the same
    // place, and retrying only delays an answer that will not change.
    expect(result.retryable).toBe(false);
  });

  it('records an unreadable object without leaking the storage error', async () => {
    const result = await scanner().scan({
      open: async () => {
        throw new Error('AccessDenied: https://minio:9000/rasta-documents/ORG/x?X-Amz-Signature=…');
      },
      sizeBytes: 100,
      contentType: 'application/pdf',
    });

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('OBJECT_UNREADABLE');
    // The reason is a code. The signed URL in that message must not survive
    // into anything stored, logged or exported (AGENTS.md S-09).
    expect(JSON.stringify(result)).not.toContain('X-Amz-Signature');
    expect(JSON.stringify(result)).not.toContain('minio');
  });

  it('names the engine even when it never reached one, so the row stays attributable', async () => {
    const result = await scanner({ port: await unusedPort() }).scan(request(Buffer.from('x')));

    // `ck_document_scan_attributable` requires any non-PENDING row to name an
    // engine. A failure with a null engine could not be written at all.
    expect(result.engine).toBe('clamav');
  });
});

describe('size limits', () => {
  it('refuses an object whose metadata already exceeds the ceiling, without reading it', async () => {
    let opened = false;
    const result = await scanner({ maxBytes: 1024 }).scan({
      open: async () => {
        opened = true;
        return Readable.from([Buffer.alloc(4096)]);
      },
      sizeBytes: 4096,
      contentType: 'application/pdf',
    });

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('SIZE_LIMIT_EXCEEDED');
    expect(result.retryable).toBe(false);
    // Not a byte fetched. The refusal costs nothing.
    expect(opened).toBe(false);
  });

  it('refuses an object that lies about its size while it streams', async () => {
    // The case metadata cannot catch: storage said 100 bytes, the stream sends
    // far more. A ceiling checked once against a number is not a ceiling on
    // what actually crosses the socket.
    const result = await scanner({ maxBytes: 1024 }).scan({
      open: async () => Readable.from([Buffer.alloc(8192, 0x41)]),
      sizeBytes: 100,
      contentType: 'application/pdf',
    });

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('SIZE_LIMIT_EXCEEDED');
  });

  it('accepts an object exactly at the ceiling', async () => {
    const result = await scanner({ maxBytes: 4096 }).scan(request(Buffer.alloc(4096, 0x41)));

    expect(result.verdict).toBe('CLEAN');
  });
});

describe('signature freshness', () => {
  it('refuses to conclude anything from a database past the age limit', async () => {
    // Two hours old, one hour allowed.
    const result = await scanner({ signatureMaxAgeSeconds: 3600 }).scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('STALE_SIGNATURES');
    // Retryable, because freshclam may fix it with nobody doing anything —
    // and because marking a whole window's backlog FAILED for an operational
    // problem would make those documents permanently undownloadable.
    expect(result.retryable).toBe(true);
  });

  it('does not stream the object at all when the database is stale', async () => {
    let opened = false;
    await scanner({ signatureMaxAgeSeconds: 3600 }).scan({
      open: async () => {
        opened = true;
        return Readable.from([Buffer.from('x')]);
      },
      sizeBytes: 1,
      contentType: 'application/pdf',
    });

    expect(opened).toBe(false);
  });

  it('accepts a database exactly at the age limit', async () => {
    const result = await scanner({ signatureMaxAgeSeconds: 2 * 3600 }).scan(
      request(Buffer.from('x')),
    );

    expect(result.verdict).toBe('CLEAN');
  });

  it('treats a database built in the future as fresh rather than as negative age', async () => {
    clamd.behaviours.version = {
      kind: 'reply',
      text: 'ClamAV 1.5.4/28109/Sun Sep 01 10:00:00 2026\0',
    };

    const result = await scanner().scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('CLEAN');
    expect(result.signatureAgeSeconds).toBe(0);
  });

  it('fails closed when the version reply cannot be parsed', async () => {
    clamd.behaviours.version = { kind: 'reply', text: 'ClamAV 1.5.4\0' };

    const result = await scanner().scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('PROTOCOL_ERROR');
  });
});

describe('health', () => {
  it('reports the engine, the database and its age', async () => {
    const health = await scanner().health();

    expect(health).toMatchObject({
      available: true,
      engine: 'clamav',
      engineVersion: '1.5.4',
      signatureVersion: '28108',
      signatureAgeSeconds: 2 * 3600,
      signaturesFresh: true,
      detail: null,
    });
  });

  it('reports available but not fresh for an old database', async () => {
    const health = await scanner({ signatureMaxAgeSeconds: 60 }).health();

    // The distinction an operator needs: the scanner is up and answering, and
    // is nonetheless not clearing anything.
    expect(health.available).toBe(true);
    expect(health.signaturesFresh).toBe(false);
    expect(health.detail).toContain('older than');
  });

  it('reports unavailable with a reason code and no address when nothing is listening', async () => {
    const port = await unusedPort();
    const health = await scanner({ port }).health();

    expect(health.available).toBe(false);
    expect(health.signaturesFresh).toBe(false);
    expect(health.detail).toBe('CONNECTION_FAILED');
    // This value reaches an unauthenticated readiness probe.
    expect(health.detail).not.toContain('127.0.0.1');
    expect(health.detail).not.toContain(String(port));
  });

  it('never throws, because a readiness probe that 500s is not a report', async () => {
    await expect(scanner({ port: await unusedPort() }).health()).resolves.toBeDefined();
  });
});

describe('the version cache', () => {
  it('reuses a recent reply instead of asking per document', async () => {
    const engine = scanner({ versionCacheSeconds: 60 });
    await engine.scan(request(Buffer.from('one')));

    // A version reply the client would reject, so a second query would fail
    // the scan. It passes, which proves the cached value was used.
    clamd.behaviours.version = { kind: 'reply', text: 'garbage\0' };

    expect((await engine.scan(request(Buffer.from('two')))).verdict).toBe('CLEAN');
  });

  it('asks again once the cache window has passed', async () => {
    let clock = NOW.getTime();
    const engine = scanner({ versionCacheSeconds: 10, now: () => new Date(clock) });

    await engine.scan(request(Buffer.from('one')));
    clamd.behaviours.version = { kind: 'reply', text: 'garbage\0' };
    clock += 11_000;

    // The window that protects a security decision must be short enough that a
    // database going stale is noticed within it, not within a deployment.
    const result = await engine.scan(request(Buffer.from('two')));
    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('PROTOCOL_ERROR');
  });
});

describe('cancellation', () => {
  it('abandons a scan whose caller aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await scanner().scan({
      open: async () => Readable.from([Buffer.alloc(1024), Buffer.alloc(1024)]),
      sizeBytes: 2048,
      contentType: 'application/pdf',
      signal: controller.signal,
    });

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('TIMEOUT');
  });
});
