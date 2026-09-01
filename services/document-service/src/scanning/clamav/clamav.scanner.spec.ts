import { Readable } from 'node:stream';
import { ClamAvMalwareScanner } from './clamav.scanner';
import { startFakeClamd, unusedPort, type FakeClamd } from '../../../test/fake-clamd';
import { MAX_REPLY_BYTES } from './clamd.client';
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

const NUL = String.fromCharCode(0);
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

/**
 * A stream that yields one chunk and then stalls forever.
 *
 * The shape of a MinIO connection that has gone quiet: TCP is up, some bytes
 * arrived, and the next read will never be answered. `Readable.from` cannot
 * express it — an array iterator always ends — so this is a real `Readable`
 * whose `_read` deliberately does nothing after the first push.
 *
 * The distinction matters: a source that *ends* lets the scan finish, and a
 * source that *errors* lets it fail. Only a source that neither ends nor
 * errors can prove the deadline is a deadline.
 */
function stalledSource(first = Buffer.alloc(1024, 0x41)): Readable {
  let sent = false;
  return new Readable({
    read() {
      if (sent) return; // and never again
      sent = true;
      this.push(first);
    },
  });
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
  it('abandons a scan whose caller aborted before it began', async () => {
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

  it('interrupts a source that is waiting for its next chunk', async () => {
    // The case the previous implementation could not handle. The abort is
    // raised *after* the first chunk has been consumed, while the loop is
    // parked on the next one — so a check between chunks never runs again, and
    // only something that reaches into the stream itself can end the scan.
    const controller = new AbortController();
    const source = stalledSource();

    const started = Date.now();
    const scanning = scanner({ timeoutMs: 60_000 }).scan({
      open: async () => source,
      sizeBytes: 4096,
      contentType: 'application/pdf',
      signal: controller.signal,
    });

    // Long enough for the first chunk to be consumed and the loop to be
    // waiting, short enough that the 60s deadline cannot be what ends this.
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();

    const result = await scanning;

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('TIMEOUT');
    expect(source.destroyed).toBe(true);
    // Ended by the abort, not by the deadline it never reached.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

/**
 * The deadline, as a deadline rather than as a claim.
 *
 * `DOCUMENT_SCAN_TIMEOUT_MS` is documented as covering the whole exchange —
 * connection, streaming, backpressure and reply. It did not: the timer
 * destroyed the clamd socket and rejected the reply promise, and neither of
 * those unblocks a `for await` parked on a source that has stopped producing.
 * The stream was destroyed in the loop's `finally`, which cannot run until the
 * loop resumes, so a stalled MinIO connection held the worker slot
 * indefinitely while the configuration said sixty seconds.
 *
 * These tests fail against that implementation by hanging, which is the point:
 * a deadline that cannot be observed to fire is not one.
 */
describe('the whole-exchange deadline', () => {
  it('returns within the deadline when the object stream stalls', async () => {
    const source = stalledSource();
    const started = Date.now();

    const result = await scanner({ timeoutMs: 700 }).scan({
      open: async () => source,
      sizeBytes: 4096,
      contentType: 'application/pdf',
    });

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('TIMEOUT');
    expect(result.retryable).toBe(true);
    // Generously bounded, but far below "never".
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('destroys the stalled source rather than leaving it reading', async () => {
    const source = stalledSource();

    await scanner({ timeoutMs: 700 }).scan({
      open: async () => source,
      sizeBytes: 4096,
      contentType: 'application/pdf',
    });

    // Not merely abandoned: a stream left readable keeps its S3 connection
    // open until the SDK's own timeout, which is the leak this ceiling exists
    // to prevent.
    expect(source.destroyed).toBe(true);
  });

  it('closes the clamd connection rather than leaving a scanning thread held', async () => {
    const before = clamd.connections();

    await scanner({ timeoutMs: 700 }).scan({
      open: async () => stalledSource(),
      sizeBytes: 4096,
      contentType: 'application/pdf',
    });

    // A scan that returns while its socket is still open has not finished; it
    // has stopped waiting, and clamd holds a thread for it until ReadTimeout.
    await clamd.waitForAllClosed();
    expect(clamd.connections().opened).toBeGreaterThan(before.opened);
  });

  it('returns within the deadline when the scanner stops reading', async () => {
    // The backpressure half, and the third place an exchange can block. A peer
    // that accepts and then stops consuming fills both kernel buffers, after
    // which `socket.write` returns false and the client waits for `drain` — a
    // wait this peer will never satisfy.
    //
    // Distinct from a silent scanner, which keeps reading: that one blocks on
    // the reply and the old timer did reach it. This one blocks *inside* the
    // send loop, where the old timer could not.
    clamd.behaviours.instream = { kind: 'blackhole' };

    // Four megabytes, reused rather than allocated per iteration. Enough to
    // close the send window several times over on any platform's default
    // socket buffers, and light enough that this test is not the reason a
    // parallel run runs out of room.
    const block = Buffer.alloc(256 * 1024, 0x41);
    const source = Readable.from(
      (function* () {
        for (let i = 0; i < 16; i += 1) yield block;
      })(),
    );

    const started = Date.now();
    const result = await scanner({ timeoutMs: 900, maxBytes: 64 * 1024 * 1024 }).scan({
      open: async () => source,
      sizeBytes: 4 * 1024 * 1024,
      contentType: 'application/pdf',
    });

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('TIMEOUT');
    expect(source.destroyed).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('never opens the object at all when the scanner cannot be reached', async () => {
    // Nothing to leak, because nothing is fetched. The version read happens
    // before the object is opened precisely so an unreachable scanner costs no
    // S3 request — the same ordering that makes an oversize refusal free.
    let opened = false;

    const result = await scanner({ port: await unusedPort(), timeoutMs: 5_000 }).scan({
      open: async () => {
        opened = true;
        return stalledSource();
      },
      sizeBytes: 4096,
      contentType: 'application/pdf',
    });

    expect(result.failureReason).toBe('CONNECTION_FAILED');
    expect(opened).toBe(false);
  });

  it('closes the object stream when the caller had already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const source = stalledSource();

    const result = await scanner().scan({
      open: async () => source,
      sizeBytes: 4096,
      contentType: 'application/pdf',
      signal: controller.signal,
    });

    expect(result.failureReason).toBe('TIMEOUT');
    expect(source.destroyed).toBe(true);
  });

  it('still distinguishes a size refusal from a deadline', async () => {
    // The deadline must not swallow the other failure kinds. This source is
    // healthy and simply too large; the answer is a policy refusal, not a
    // timeout, and it is not retryable.
    const result = await scanner({ maxBytes: 1024, timeoutMs: 10_000 }).scan({
      open: async () => Readable.from([Buffer.alloc(8192, 0x41)]),
      sizeBytes: 100,
      contentType: 'application/pdf',
    });

    expect(result.failureReason).toBe('SIZE_LIMIT_EXCEEDED');
    expect(result.retryable).toBe(false);
  });

  it('still distinguishes a refused connection from a deadline', async () => {
    const result = await scanner({ port: await unusedPort(), timeoutMs: 10_000 }).scan(
      request(Buffer.from('x')),
    );

    expect(result.failureReason).toBe('CONNECTION_FAILED');
  });
});

/**
 * A close is not a verdict.
 *
 * `fail()` is latched against a second *failure*, not against a success, so
 * `onClose` firing after a complete reply could still abort the exchange —
 * turning a valid verdict into `PROTOCOL_ERROR`, which for an `INFECTED` reply
 * means losing a real finding and recording an unexplained failure instead.
 *
 * **These three do not fail without the `answered` guard, and that is stated
 * rather than glossed.** On the current path the reply's continuation is a
 * microtask and the close is a macrotask, so the verdict wins the race by
 * scheduling. What they pin is the behaviour itself — a reply followed by a
 * close is the verdict, a partial reply followed by a close is a failure — so
 * that a future change to either ordering is caught here rather than in
 * production. The guard makes the rule explicit; these make it observable.
 */
describe('a reply followed immediately by a close', () => {
  it('keeps a clean verdict when the scanner hangs up straight after answering', async () => {
    clamd.behaviours.instream = { kind: 'reply-then-close', text: 'stream: OK' + NUL };

    const result = await scanner({ timeoutMs: 10_000 }).scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('CLEAN');
    expect(result.failureReason).toBeNull();
  });

  it('keeps an infected verdict when the scanner hangs up straight after answering', async () => {
    // The case with something to lose. A finding turned into a failure is not
    // merely a wrong label: the document still refuses to download, but
    // `VIRUS_DETECTED` is never published and nobody is told.
    clamd.behaviours.instream = {
      kind: 'reply-then-close',
      text: 'stream: Eicar-Test-Signature FOUND' + NUL,
    };

    const result = await scanner({ timeoutMs: 10_000 }).scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('INFECTED');
    expect(result.signature).toBe('Eicar-Test-Signature');
  });

  it('still fails when the scanner hangs up before terminating its reply', async () => {
    // The other side of the guard: `answered` is only true for a *complete*
    // reply, so a close over a partial one remains a protocol failure rather
    // than being read as whatever had arrived so far.
    clamd.behaviours.instream = { kind: 'reply-then-close', text: 'stream: OK' };

    const result = await scanner({ timeoutMs: 10_000 }).scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('PROTOCOL_ERROR');
  });
});

describe('the reply size bound', () => {
  it('refuses a reply that never terminates, rather than buffering it', async () => {
    // A healthy clamd answers in under a hundred bytes and always terminates.
    // Without a bound, a peer that is broken or hostile can make this process
    // hold whatever it chooses to send — and the accumulator concatenated the
    // whole buffer on every packet, so the cost grew quadratically as it did.
    clamd.behaviours.instream = { kind: 'flood', bytes: 64 * 1024 };

    const result = await scanner({ timeoutMs: 10_000 }).scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('FAILED');
    // A protocol failure, not a timeout: the scanner answered, and what it
    // said was not a reply.
    expect(result.failureReason).toBe('PROTOCOL_ERROR');
  });

  it('says how much it refused without repeating any of it', async () => {
    // The refusal reaches logs and metrics. Echoing an unbounded reply from an
    // untrusted peer into either is the second bug, not the fix (S-09).
    clamd.behaviours.instream = { kind: 'flood', bytes: 64 * 1024 };

    const result = await scanner({ timeoutMs: 10_000 }).scan(request(Buffer.from('x')));

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('AAAA');
    expect(result.failureReason).toBe('PROTOCOL_ERROR');
  });

  it('refuses an oversized reply even when it is properly terminated', async () => {
    // The bypass. The size check used to sit behind an early return on the
    // terminator, so a peer that ended an oversized reply with a NUL had it
    // accepted and concatenated in full — the bound was documented and not
    // enforced. Terminating late must not buy more room.
    clamd.behaviours.instream = { kind: 'reply', text: 'A'.repeat(16 * 1024) + NUL };

    const result = await scanner({ timeoutMs: 10_000 }).scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('PROTOCOL_ERROR');
    expect(JSON.stringify(result)).not.toContain('AAAA');
  });

  it('refuses a reply whose terminator arrives in the chunk that crosses the limit', async () => {
    // The boundary case, made deterministic by splitting either side of it:
    // everything before the terminator fits, and the arrival that carries it
    // is what takes the reply past the bound. A check applied only to
    // unterminated data would accept this one.
    clamd.behaviours.instream = {
      kind: 'split',
      first: 'A'.repeat(MAX_REPLY_BYTES - 10),
      second: 'B'.repeat(40) + NUL,
      delayMs: 20,
    };

    const result = await scanner({ timeoutMs: 10_000 }).scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('FAILED');
    expect(result.failureReason).toBe('PROTOCOL_ERROR');
  });

  it('accepts a fragmented reply that stays inside the bound', async () => {
    // The property the bound must not cost: a real reply split across packets
    // is still a real reply. Sized close enough to the limit that an
    // off-by-one in the accounting would refuse it.
    const signature = 'S'.repeat(200);
    clamd.behaviours.instream = {
      kind: 'split',
      first: 'stream: ' + signature.slice(0, 100),
      second: signature.slice(100) + ' FOUND' + NUL,
      delayMs: 20,
    };

    const result = await scanner({ timeoutMs: 10_000 }).scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('INFECTED');
    expect(result.signature).toBe(signature);
  });

  it('accepts a reply comfortably inside the bound', async () => {
    clamd.behaviours.instream = {
      kind: 'reply',
      text: 'stream: ' + 'S'.repeat(200) + ' FOUND' + NUL,
    };

    const result = await scanner().scan(request(Buffer.from('x')));

    expect(result.verdict).toBe('INFECTED');
  });
});
