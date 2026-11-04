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
  bytes(): Buffer {
    return this.owned ? this.owned.subarray(0, this.size) : Buffer.alloc(0);
  }

  /** Drops what was collected. */
  clear(): void {
    this.owned = undefined;
    this.size = 0;
  }
}

/**
 * The body as UTF-8 text, or `null` once it exceeds `limit` bytes — declared
 * or read — after which reading stops and the stream is cancelled.
 */
export async function readCappedText(response: Response, limit: number): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const body = new BoundedBodyCollector(limit);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!body.append(value)) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
  }
  return body.bytes().toString('utf8');
}
