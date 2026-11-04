import { ExchangeDeadlineError, exchangeDeadlineOf } from './exchange-deadline';

/**
 * Byte-capped collection of a peer's body whose memory follows the bytes
 * received, never the cap and never the number of chunks (FU-044, FU-081).
 *
 * Keeping every incoming chunk object until a final concat costs one object
 * (plus its backing store) per chunk: a peer that sends a capped body one byte
 * per read multiplies the cap by the per-chunk overhead. Here each chunk is
 * copied into one owned buffer that grows geometrically up to the cap, and the
 * chunk itself is released as soon as `append` returns.
 */
export class BoundedBodyCollector {
  private owned: Buffer | undefined;
  private size = 0;

  constructor(
    private readonly limit: number,
    private readonly minBufferBytes = 256,
  ) {}

  get byteLength(): number {
    return this.size;
  }

  /**
   * Copies `chunk` in, or answers `false` — copying nothing — when it would
   * take the total past the cap. Exactly the cap is accepted.
   */
  append(chunk: Uint8Array): boolean {
    if (chunk.byteLength > this.limit - this.size) return false;
    const needed = this.size + chunk.byteLength;
    if (!this.owned || needed > this.owned.byteLength) {
      const grown = Math.min(
        this.limit,
        Math.max(needed, this.minBufferBytes, (this.owned?.byteLength ?? 0) * 2),
      );
      const next = Buffer.alloc(grown);
      if (this.owned) this.owned.copy(next, 0, 0, this.size);
      this.owned = next;
    }
    this.owned.set(chunk, this.size);
    this.size = needed;
    return true;
  }

  /** The bytes received so far (a view; empty when nothing arrived). */
  toBuffer(): Buffer {
    return this.owned ? this.owned.subarray(0, this.size) : Buffer.alloc(0);
  }

  /** Drops what was collected. */
  clear(): void {
    this.owned = undefined;
    this.size = 0;
  }
}

/**
 * What {@link readBoundedText} / {@link readBoundedJson} reject with when the
 * body is larger than the caller's limit. Carries no URL, header or body.
 */
export class BodyTooLargeError extends Error {
  constructor() {
    super('The response body exceeded its byte limit');
    this.name = 'BodyTooLargeError';
  }
}

export interface CappedReadOptions {
  /**
   * A monotonic deadline (`performance.now()`) checked between chunks, for a
   * read outside {@link exchangeWithDeadline}; inside one, the exchange's own
   * deadline applies without being passed. The earlier of the two wins.
   */
  readonly deadlineAt?: number;
}

/**
 * The body's bytes, or `null` once it exceeds `limit` bytes — declared or
 * read, after any content decoding — after which reading stops and the stream
 * is cancelled. Past the deadline (the exchange's, or `options.deadlineAt`)
 * the stream is cancelled and it rejects with `ExchangeDeadlineError`: an
 * always-ready stream would otherwise keep the abort timer from ever running
 * (PR #722 r1 F2).
 */
async function collectCapped(
  response: Response,
  limit: number,
  options: CappedReadOptions,
): Promise<Buffer | null> {
  const exchange = exchangeDeadlineOf(response);
  const deadlineAt = Math.min(exchange?.at ?? Infinity, options.deadlineAt ?? Infinity);
  const late = () => new ExchangeDeadlineError(exchange?.timeoutMs ?? 0);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const body = new BoundedBodyCollector(limit);
  for (;;) {
    if (performance.now() >= deadlineAt) {
      await reader.cancel().catch(() => undefined);
      throw late();
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (!body.append(value)) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
  }
  if (performance.now() >= deadlineAt) throw late();
  return body.toBuffer();
}

/**
 * The body as UTF-8 text, or `null` once it exceeds `limit` bytes; see
 * `collectCapped` for the deadline.
 */
export async function readCappedText(
  response: Response,
  limit: number,
  options: CappedReadOptions = {},
): Promise<string | null> {
  const bytes = await collectCapped(response, limit, options);
  return bytes === null ? null : bytes.toString('utf8');
}

/**
 * The bounded drop-in for `response.text()`: the same text, but rejects with
 * {@link BodyTooLargeError} past `limit` bytes. Every peer body is read through
 * this module (`bounded-body.sweep.spec.ts`), never through the unbounded
 * `Response` readers.
 */
export async function readBoundedText(
  response: Response,
  limit: number,
  options: CappedReadOptions = {},
): Promise<string> {
  const text = await readCappedText(response, limit, options);
  if (text === null) throw new BodyTooLargeError();
  return text;
}

/**
 * The bounded drop-in for `response.json()`: rejects with
 * {@link BodyTooLargeError} past `limit` bytes and, like `.json()`, with a
 * `SyntaxError` when the body is not JSON.
 */
export async function readBoundedJson(
  response: Response,
  limit: number,
  options: CappedReadOptions = {},
): Promise<unknown> {
  return JSON.parse(await readBoundedText(response, limit, options)) as unknown;
}
