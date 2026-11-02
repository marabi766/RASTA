import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BROKER_DEFAULT_ALREADY_ABSENT,
  brokerDefaultDeleteOutcome,
  withBrokerDefault,
} from './broker-default.mjs';

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
      assert.equal(writes, 2);
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
        pause: async () => {},
      }),
      /restoration unconfirmed/,
    );
    assert.equal(current, before);
  });
}

for (const before of [undefined, 1100000]) {
  for (const failure of ['setup', 'work', 'none']) {
    test(`stale matching read after ${failure}, original ${before}: always compensates`, async () => {
      let current = before;
      const writes = [];
      let reads = 0;
      const result = withBrokerDefault(
        3145728,
        async () => {
          if (failure === 'work') throw new Error('work failed');
        },
        {
          read: async () => {
            reads += 1;
            return reads <= 2 ? before : current;
          },
          set: async (value) => {
            writes.push(value);
            current = value;
            if (writes.length === 1 && failure === 'setup') throw new Error('setup response lost');
          },
          pause: async () => {},
        },
      );
      if (failure === 'none') await result;
      else await assert.rejects(result, /setup response lost|work failed/);
      assert.deepEqual(writes, [3145728, before]);
      assert.equal(current, before);
    });
  }
  test(`restoration delayed visibility and lost response, original ${before}`, async () => {
    let reads = 0;
    let writes = 0;
    let pauses = 0;
    await withBrokerDefault(3145728, async () => {}, {
      read: async () => {
        reads += 1;
        if (reads === 2) throw new Error('read unavailable');
        return reads === 3 ? 3145728 : before;
      },
      set: async () => {
        if (++writes === 2) throw new Error('restore response lost');
      },
      pause: async () => {
        pauses += 1;
      },
    });
    assert.equal(writes, 3);
    assert.equal(reads, 4);
    assert.equal(pauses, 3);
  });
  test(`unconfirmed restoration is bounded, original ${before}`, async () => {
    let reads = 0;
    let pauses = 0;
    await assert.rejects(
      withBrokerDefault(3145728, async () => {}, {
        read: async () => (++reads === 1 ? before : 3145728),
        set: async () => {},
        pause: async () => {
          pauses += 1;
        },
      }),
      /restoration unconfirmed/,
    );
    assert.equal(reads, 21);
    assert.equal(pauses, 19);
  });
}

test('failed compensation cannot be confirmed by stale matching reads', async () => {
  let writes = 0;
  let reads = 0;
  await assert.rejects(
    withBrokerDefault(3145728, async () => {}, {
      read: async () => {
        reads += 1;
        return undefined;
      },
      set: async () => {
        if (++writes > 1) throw new Error('restore refused');
      },
      pause: async () => {},
    }),
    /restoration unconfirmed/,
  );
  assert.equal(writes, 21);
  assert.equal(reads, 1);
});

test('Kafka deletion recognises only the exact known absence refusal; all other errors refuse', () => {
  const missing = { status: 1, stdout: '', stderr: 'Invalid config(s): message.max.bytes\n' };
  assert.equal(brokerDefaultDeleteOutcome(missing), BROKER_DEFAULT_ALREADY_ABSENT);
  assert.equal(brokerDefaultDeleteOutcome({ status: 0, stdout: '', stderr: '' }), undefined);
  for (const altered of [
    { status: 2 },
    { status: null },
    { stdout: 'unexpected' },
    { stderr: 'authentication failed' },
    { stderr: 'connection reset' },
    { stderr: 'Invalid config(s): other.config' },
    { stderr: 'Invalid config(s): message.max.bytes\nforeign error' },
  ])
    assert.throws(
      () => brokerDefaultDeleteOutcome({ ...missing, ...altered }),
      /deletion unconfirmed/,
    );
});

test('already absent is confirmed only after the full bounded CLI refusal window and readback', async () => {
  let writes = 0;
  let reads = 0;
  let pauses = 0;
  await withBrokerDefault(undefined, async () => {}, {
    read: async () => {
      reads += 1;
      return undefined;
    },
    set: async () => {
      writes += 1;
      return BROKER_DEFAULT_ALREADY_ABSENT;
    },
    pause: async () => {
      pauses += 1;
    },
  });
  assert.equal(writes, 20);
  assert.equal(reads, 2);
  assert.equal(pauses, 19);
});

test('stale absent CLI refusals never skip deletion when the committed override becomes visible', async () => {
  let current;
  let writes = 0;
  let pauses = 0;
  await assert.rejects(
    withBrokerDefault(3145728, async () => {}, {
      read: async () => current,
      set: async (value) => {
        writes += 1;
        if (writes === 1) {
          current = value;
          throw new Error('setup response lost');
        }
        if (writes < 5) return BROKER_DEFAULT_ALREADY_ABSENT;
        current = value;
      },
      pause: async () => {
        pauses += 1;
      },
    }),
    /setup response lost/,
  );
  assert.equal(writes, 5);
  assert.equal(pauses, 3);
  assert.equal(current, undefined);
});

for (const issue of ['unknown-write', 'unreadable', 'override-present', 'wrong-provenance']) {
  test(`known absence cannot mask ${issue}`, async () => {
    let writes = 0;
    let reads = 0;
    const before = issue === 'wrong-provenance' ? 1100000 : undefined;
    await assert.rejects(
      withBrokerDefault(before, async () => {}, {
        read: async () => {
          if (++reads === 1) return before;
          if (issue === 'unreadable') throw new Error('unreadable');
          return issue === 'override-present' ? 3145728 : before;
        },
        set: async () => {
          if (++writes === 10 && issue === 'unknown-write') throw new Error('unconfirmed');
          return BROKER_DEFAULT_ALREADY_ABSENT;
        },
        pause: async () => {},
      }),
      /restoration unconfirmed/,
    );
    assert.equal(writes, 20);
  });
}
