import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBrokerDefault } from './broker-default.mjs';

for (const [label, before, target] of [
  ['add', undefined, 3145728],
  ['replace', 1100000, 3145728],
  ['delete', 1100000, undefined],
]) {
  for (const commits of [false, true]) {
    test(`${label}: setup ${commits ? 'commits then errors' : 'fails before commit'} restores provenance`, async () => {
      let current = before;
      let writes = 0;
      let worked = false;
      await assert.rejects(
        withBrokerDefault(target, async () => (worked = true), {
          read: async () => current,
          set: async (value) => {
            writes += 1;
            if (writes > 1 || commits) current = value;
            if (writes === 1) throw new Error('setup response lost');
          },
        }),
        /setup response lost/,
      );
      assert.equal(worked, false);
      assert.equal(current, before);
      assert.equal(writes, commits ? 2 : 1);
    });
  }
}

for (const before of [undefined, 1100000]) {
  for (const fails of [false, true]) {
    test(`work ${fails ? 'throws' : 'returns'}, original ${before}: restores even when setup was a no-op`, async () => {
      let current = before;
      const result = withBrokerDefault(
        before,
        async () => {
          current = 3145728;
          if (fails) throw new Error('work failed');
          return 'worked';
        },
        {
          read: async () => current,
          set: async (value) => {
            current = value;
          },
        },
      );
      if (fails) await assert.rejects(result, /work failed/);
      else assert.equal(await result, 'worked');
      assert.equal(current, before);
    });
  }
  test(`restoration read fails, original ${before}: still reapplies original provenance`, async () => {
    let current = before;
    let reads = 0;
    await assert.rejects(
      withBrokerDefault(3145728, async () => {}, {
        read: async () => {
          if (reads++ > 0) throw new Error('unreadable');
          return current;
        },
        set: async (value) => {
          current = value;
        },
      }),
      /restoration: read failed/,
    );
    assert.equal(current, before);
  });
}
