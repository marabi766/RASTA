/**
 * A bounded fingerprint of a stored record's exact text: its length and the
 * SHA-256 of its UTF-16 code units (big-endian), so two texts share one only
 * if they are the same text. What an acknowledgement keeps in place of a copy
 * of the record (`lib/unresolved-tenancy.ts`; PR 405 review 3, R2): about
 * seventy characters whatever the record's size.
 *
 * Synchronous on purpose: the check and the write that depends on it happen in
 * one turn, so nothing can change the record between them (SubtleCrypto would
 * put an `await` there).
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

const rotate = (value: number, by: number): number => (value >>> by) | (value << (32 - by));

/** SHA-256 of `text`'s UTF-16 code units, each as two big-endian bytes; lowercase hex. */
export function sha256OfUnits(text: string): string {
  const length = text.length * 2;
  // Message, the 0x80 byte, zero padding, and the 64-bit bit length.
  const blocks = Math.ceil((length + 9) / 64);
  const bytes = new Uint8Array(blocks * 64);
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    bytes[index * 2] = unit >>> 8;
    bytes[index * 2 + 1] = unit & 0xff;
  }
  bytes[length] = 0x80;
  const view = new DataView(bytes.buffer);
  const bits = length * 8;
  view.setUint32(bytes.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(bytes.length - 4, bits >>> 0);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let block = 0; block < blocks; block += 1) {
    for (let t = 0; t < 16; t += 1) w[t] = view.getUint32(block * 64 + t * 4);
    for (let t = 16; t < 64; t += 1) {
      const a = w[t - 15]!;
      const b = w[t - 2]!;
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as number[];
    for (let t = 0; t < 64; t += 1) {
      const s1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + s1 + choice + K[t]! + w[t]!) >>> 0;
      const s0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    hash[0] = hash[0]! + a!;
    hash[1] = hash[1]! + b!;
    hash[2] = hash[2]! + c!;
    hash[3] = hash[3]! + d!;
    hash[4] = hash[4]! + e!;
    hash[5] = hash[5]! + f!;
    hash[6] = hash[6]! + g!;
    hash[7] = hash[7]! + h!;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('');
}

/** `<length in base 36>.<sha-256 hex>`: the same for two texts only if they are the same text. */
export function fingerprintOf(text: string): string {
  return `${text.length.toString(36)}.${sha256OfUnits(text)}`;
}
