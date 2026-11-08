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
      /BROKER_DEFAULT restoration UNCONFIRMED/,
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
      /BROKER_DEFAULT restoration UNCONFIRMED/,
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
    /BROKER_DEFAULT restoration UNCONFIRMED/,
  );
  assert.equal(writes, 21);
  assert.equal(reads, 1);
});

for (const failure of ['committed', 'lost-response', 'no-op setup']) {
  test(`stale absence for the entire window after ${failure} cannot confirm compensation`, async () => {
    let current;
    let writes = 0;
    let reads = 0;
    let pauses = 0;
    let worked = false;
    await assert.rejects(
      withBrokerDefault(
        failure === 'no-op setup' ? undefined : 3145728,
        async () => {
          worked = true;
          current = 3145728;
        },
        {
          // The snapshot and every readback stay absent; every deletion is refused.
          read: async () => {
            reads += 1;
            return undefined;
          },
          set: async (value) => {
            writes += 1;
            if (value !== undefined) {
              current = value;
              if (failure === 'lost-response') throw new Error('setup response lost');
            } else throw new Error('deletion refused');
          },
          pause: async () => {
            pauses += 1;
          },
        },
      ),
      /BROKER_DEFAULT restoration UNCONFIRMED/,
    );
    assert.equal(current, 3145728);
    assert.equal(worked, failure !== 'lost-response');
    assert.equal(writes, failure === 'no-op setup' ? 20 : 21);
    assert.equal(reads, 1);
    assert.equal(pauses, 19);
  });
}

test('stale absent describes and refused deletions never skip deletion when the committed override becomes visible', async () => {
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
        if (writes < 5) throw new Error('deletion refused');
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
  test(`refused deletions cannot mask ${issue}`, async () => {
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
          throw new Error('deletion refused');
        },
        pause: async () => {},
      }),
      /BROKER_DEFAULT restoration UNCONFIRMED/,
    );
    assert.equal(writes, 20);
  });
}

// The deletion adapter sends exactly one incremental DELETE, never a describe
// or a replacement of the complete broker-default map.
test('direct deletion encodes only message.max.bytes and requires the exact successful resource', async () => {
  const { deleteRequest } = await import('./broker-default-delete.mjs');
  const { createRequire } = await import('node:module');
  const Decoder = createRequire(import.meta.url)('kafkajs/src/protocol/decoder');
  const request = deleteRequest.request;
  assert.equal(request.apiKey, 44);
  assert.equal(request.apiVersion, 0);
  const wire = new Decoder((await request.encode()).buffer);
  assert.equal(wire.readInt32(), 1);
  assert.equal(wire.readInt8(), 4);
  assert.equal(wire.readString(), '');
  assert.equal(wire.readInt32(), 1);
  assert.equal(wire.readString(), 'message.max.bytes');
  assert.equal(wire.readInt8(), 1);
  assert.equal(wire.readString(), null);
  assert.equal(wire.readBoolean(), false);
  const success = { errorCode: 0, resourceType: 4, resourceName: '' };
  await deleteRequest.response.parse({ resources: [success] });
  for (const resources of [
    [],
    [success, success],
    [{ ...success, errorCode: 31 }],
    [{ ...success, resourceType: 2 }],
    [{ ...success, resourceName: '0' }],
  ]) {
    await assert.rejects(deleteRequest.response.parse({ resources }), /deletion UNCONFIRMED/);
  }
});

test('malformed deletion endpoint refuses without retaining configuration input', async () => {
  const { deleteBrokerDefault } = await import('./broker-default-delete.mjs');
  await assert.rejects(
    deleteBrokerDefault({
      brokers: ['[invalid-private-endpoint'],
      clusterId: 'rasta-ci-cluster-000001',
    }),
    (error) => {
      assert.equal(error.message, 'BROKER_DEFAULT endpoint UNCONFIRMED');
      assert.equal(error.input, undefined);
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

// FU-006: the DELETE must reach the cluster the reads/SETs resolved, checked on
// the very connection that sends it.
function fakeBroker(reportedClusterId, log) {
  return () => ({
    connect: async () => log.push('connect'),
    versions: () => ({ 44: { minVersion: 0, maxVersion: 1 } }),
    metadata: async () => {
      log.push('metadata');
      return { clusterId: reportedClusterId };
    },
    send: async (request) => {
      log.push(`send:${request.request.apiKey}`);
    },
    disconnect: async () => log.push('disconnect'),
  });
}
const target = { brokers: ['localhost:9092'], clientId: 'rasta-admin' };

test('deletion is sent only on a connection that reports the read/SET cluster', async () => {
  const { deleteBrokerDefault } = await import('./broker-default-delete.mjs');
  const log = [];
  await deleteBrokerDefault(
    { ...target, clusterId: 'rasta-ci-cluster-000001' },
    { open: fakeBroker('rasta-ci-cluster-000001', log) },
  );
  assert.deepEqual(log, ['connect', 'metadata', 'send:44', 'disconnect']);

  for (const reported of ['another-cluster-000002', undefined, null, '']) {
    const other = [];
    await assert.rejects(
      deleteBrokerDefault(
        { ...target, clusterId: 'rasta-ci-cluster-000001' },
        { open: fakeBroker(reported, other) },
      ),
      /^Error: BROKER_DEFAULT broker UNCONFIRMED$/,
    );
    assert.deepEqual(other, ['connect', 'metadata', 'disconnect']);
  }
});

test('deletion with an unresolved read/SET cluster refuses before connecting', async () => {
  const { deleteBrokerDefault } = await import('./broker-default-delete.mjs');
  for (const clusterId of [undefined, null, '', ' ', 'a b', 'x'.repeat(65), 42, 'Cluster ID: x']) {
    let opened = false;
    await assert.rejects(
      deleteBrokerDefault(
        { ...target, clusterId },
        {
          open: () => {
            opened = true;
            return fakeBroker(clusterId, [])();
          },
        },
      ),
      /^Error: BROKER_DEFAULT broker UNCONFIRMED$/,
    );
    assert.equal(opened, false);
  }
});

// FU-006 r2: the real KafkaJS Broker/ConnectionPool with replaceable in-memory
// sockets (no network). Each socket stands for one cluster and answers
// ApiVersions v2, Metadata v2 and IncrementalAlterConfigs v0 with encoded frames.
async function memorySockets(script) {
  const { createRequire } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const require = createRequire(import.meta.url);
  const Encoder = require('kafkajs/src/protocol/encoder');
  const Decoder = require('kafkajs/src/protocol/decoder');
  const log = [];
  const bodies = {
    18: () =>
      new Encoder()
        .writeInt16(0)
        .writeArray(
          [
            [18, 0, 2],
            [3, 0, 2],
            [44, 0, 0],
          ].map(([key, min, max]) => new Encoder().writeInt16(key).writeInt16(min).writeInt16(max)),
        )
        .writeInt32(0),
    3: (cluster) => new Encoder().writeArray([]).writeString(cluster).writeInt32(-1).writeArray([]),
    44: () =>
      new Encoder()
        .writeInt32(0)
        .writeArray([new Encoder().writeInt16(0).writeString(null).writeInt8(4).writeString('')]),
  };
  let index = 0;
  const factory = ({ onConnect }) => {
    const { cluster, finAfter } = script[index++] ?? {};
    const socket = new EventEmitter();
    log.push(`socket:${cluster}`);
    socket.setKeepAlive = () => {};
    socket.unref = () => {};
    socket.end = () => {};
    socket.write = (buffer) => {
      const request = new Decoder(buffer);
      request.readInt32();
      const apiKey = request.readInt16();
      request.readInt16();
      const correlationId = request.readInt32();
      log.push(`${apiKey}:${cluster}`);
      const body = new Encoder().writeInt32(correlationId).writeEncoder(bodies[apiKey](cluster));
      const frame = new Encoder().writeInt32(body.size()).writeEncoder(body).buffer;
      setImmediate(() => {
        socket.emit('data', frame);
        // The FIN arrives with the response, before the client's next request.
        if (apiKey === finAfter) socket.emit('end');
      });
    };
    setImmediate(onConnect);
    return socket;
  };
  return { factory, log };
}

async function realPool(script) {
  const { deleteBrokerDefault, openBroker } = await import('./broker-default-delete.mjs');
  const { factory, log } = await memorySockets(script);
  const run = () =>
    deleteBrokerDefault(
      { ...target, clusterId: 'cluster-A' },
      { open: (endpoint, options) => openBroker(endpoint, options, factory) },
    );
  return { run, log };
}

test('real pool: deletion is written on the socket that reported the read/SET cluster', async () => {
  const { run, log } = await realPool([{ cluster: 'cluster-A' }]);
  await run();
  assert.deepEqual(log, ['socket:cluster-A', '18:cluster-A', '3:cluster-A', '44:cluster-A']);
});

test('real pool: a peer FIN after the cluster check refuses instead of reconnecting', async () => {
  const { run, log } = await realPool([
    { cluster: 'cluster-A', finAfter: 3 },
    { cluster: 'cluster-B' },
  ]);
  await assert.rejects(
    run(),
    /^KafkaJSConnectionError: Failed to connect: BROKER_DEFAULT broker UNCONFIRMED$/,
  );
  assert.ok(!log.includes('socket:cluster-B'), log.join(' -> '));
  assert.ok(!log.some((entry) => entry.startsWith('44:')), log.join(' -> '));
});

test('one-socket factory refuses every socket after the first', async () => {
  const { oneSocket } = await import('./broker-default-delete.mjs');
  let created = 0;
  const factory = oneSocket(() => ++created);
  assert.equal(factory({}), 1);
  assert.throws(() => factory({}), /^Error: BROKER_DEFAULT broker UNCONFIRMED$/);
  assert.throws(() => factory({}), /^Error: BROKER_DEFAULT broker UNCONFIRMED$/);
  assert.equal(created, 1);
});
