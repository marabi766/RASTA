import { createHash, randomBytes } from 'node:crypto';
import { ResumableSha256 } from './resumable-sha256';

const reference = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

describe('ResumableSha256', () => {
  it.each([0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000])(
    'digests %i bytes as node:crypto does',
    (size) => {
      const data = randomBytes(size);
      expect(ResumableSha256.fresh().update(data).hex()).toBe(reference(data));
    },
  );

  it('digests the empty string as the empty set of ids digests', () => {
    expect(ResumableSha256.fresh().hex()).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('gives the same digest whatever the input is cut into, saved and taken up again between the pieces', () => {
    for (let round = 0; round < 200; round += 1) {
      const data = randomBytes(Math.floor(Math.random() * 700));
      let hash = ResumableSha256.fresh();
      let offset = 0;
      while (offset < data.length) {
        const take = Math.min(data.length - offset, Math.floor(Math.random() * 130));
        hash = ResumableSha256.restore(hash.update(data.subarray(offset, offset + take)).save());
        offset += take;
      }
      expect(hash.hex()).toBe(reference(data));
      expect(hash.byteLength).toBe(data.length);
    }
  });

  it('leaves its state as it was when asked for the digest', () => {
    const hash = ResumableSha256.fresh().update('DMD_1');
    expect(hash.hex()).toBe(reference(Buffer.from('DMD_1')));
    hash.update('\nDMD_2');
    expect(hash.hex()).toBe(reference(Buffer.from('DMD_1\nDMD_2')));
  });

  it('saves the eight words, the length and only the bytes of the incomplete block', () => {
    expect(ResumableSha256.fresh().save()).toHaveLength(40);
    expect(ResumableSha256.fresh().update(randomBytes(64)).save()).toHaveLength(40);
    expect(ResumableSha256.fresh().update(randomBytes(70)).save()).toHaveLength(46);
  });

  it('refuses a state of the wrong shape', () => {
    const state = ResumableSha256.fresh().update(randomBytes(70)).save();
    expect(() => ResumableSha256.restore(state.subarray(0, 39))).toThrow(/at least 40 bytes/);
    expect(() => ResumableSha256.restore(state.subarray(0, 45))).toThrow(/incomplete block/);
    expect(() => ResumableSha256.restore(Buffer.concat([state, Buffer.from([0])]))).toThrow(
      /incomplete block/,
    );
  });
});
