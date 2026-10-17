/**
 * SHA-256 (FIPS 180-4) whose running state can be saved and taken up again — in another
 * transaction, after a crash, in another process (PR-338 r1 F1).
 *
 * A window's end names its demands by `demandIdsDigest`: one SHA-256 of every id, sorted and
 * joined by a newline. Computed in one statement, that is work growing with the window inside one
 * transaction. Fed here in bounded batches instead, with the state stored on the window's row
 * between them, the digest is the same value and no transaction grows with the window. Neither
 * `node:crypto` nor PostgreSQL's `sha256()` lets its state out, hence this one; it is checked
 * against `node:crypto` (`resumable-sha256.spec.ts`).
 *
 * The saved state is the eight working words, the count of bytes taken so far, and the bytes of
 * the block not yet complete: `32 + 8 + (length mod 64)` bytes. `restore` refuses anything else.
 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

const BLOCK = 64;
const HEADER = 40;

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export class ResumableSha256 {
  private readonly words = new Uint32Array(64);

  private constructor(
    private readonly h: Uint32Array,
    /** Bytes taken so far. */
    private length: number,
    /** The bytes of the block not yet complete (fewer than 64). */
    private pending: Buffer,
  ) {}

  static fresh(): ResumableSha256 {
    return new ResumableSha256(Uint32Array.from(INITIAL), 0, Buffer.alloc(0));
  }

  /** Takes up a state `save` answered; refuses one of the wrong shape. */
  static restore(state: Uint8Array): ResumableSha256 {
    const bytes = Buffer.from(state);
    if (bytes.length < HEADER) throw new Error('a SHA-256 state is at least 40 bytes');
    const length = Number(bytes.readBigUInt64BE(32));
    if (!Number.isSafeInteger(length) || bytes.length !== HEADER + (length % BLOCK)) {
      throw new Error('a SHA-256 state holds the bytes of its incomplete block, and only those');
    }
    const h = new Uint32Array(8);
    for (let i = 0; i < 8; i += 1) h[i] = bytes.readUInt32BE(i * 4);
    return new ResumableSha256(h, length, Buffer.from(bytes.subarray(HEADER)));
  }

  /** Bytes taken so far. */
  get byteLength(): number {
    return this.length;
  }

  update(data: string | Uint8Array): this {
    const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    this.length += input.length;
    let offset = 0;
    if (this.pending.length > 0) {
      const take = Math.min(BLOCK - this.pending.length, input.length);
      this.pending = Buffer.concat([this.pending, input.subarray(0, take)]);
      offset = take;
      if (this.pending.length < BLOCK) return this;
      this.compress(this.pending, 0);
      this.pending = Buffer.alloc(0);
    }
    for (; offset + BLOCK <= input.length; offset += BLOCK) this.compress(input, offset);
    this.pending = Buffer.from(input.subarray(offset));
    return this;
  }

  save(): Buffer<ArrayBuffer> {
    const state = Buffer.alloc(HEADER + this.pending.length);
    for (let i = 0; i < 8; i += 1) state.writeUInt32BE(this.h[i] as number, i * 4);
    state.writeBigUInt64BE(BigInt(this.length), 32);
    this.pending.copy(state, HEADER);
    return state;
  }

  /** The digest of everything taken, as lowercase hex. The state itself is left as it was. */
  hex(): string {
    const copy = ResumableSha256.restore(this.save());
    const bits = BigInt(copy.length) * 8n;
    const padding = Buffer.alloc(((BLOCK + 56 - ((copy.length + 1) % BLOCK)) % BLOCK) + 1);
    padding[0] = 0x80;
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(bits);
    copy.update(padding).update(size);
    const out = Buffer.alloc(32);
    for (let i = 0; i < 8; i += 1) out.writeUInt32BE(copy.h[i] as number, i * 4);
    return out.toString('hex');
  }

  private compress(block: Buffer, offset: number): void {
    const w = this.words;
    for (let t = 0; t < 16; t += 1) w[t] = block.readUInt32BE(offset + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15] as number;
      const w2 = w[t - 2] as number;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = ((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) >>> 0;
    }
    const h = this.h;
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + (K[t] as number) + (w[t] as number)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = ((h[0] as number) + a) >>> 0;
    h[1] = ((h[1] as number) + b) >>> 0;
    h[2] = ((h[2] as number) + c) >>> 0;
    h[3] = ((h[3] as number) + d) >>> 0;
    h[4] = ((h[4] as number) + e) >>> 0;
    h[5] = ((h[5] as number) + f) >>> 0;
    h[6] = ((h[6] as number) + g) >>> 0;
    h[7] = ((h[7] as number) + hh) >>> 0;
  }
}
