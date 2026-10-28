/** @jest-environment node */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { connect, Socket } from 'node:net';

import {
  cleanupFixtures,
  LOST_DIAGNOSTIC,
  signalChild,
  supervisorEndpoint,
  trackFixture,
} from './test/build-lifetime';

/**
 * The test side of the controller lifecycle (Codex PR-420 r6 R6-1), against a modeled
 * controller peer. The real controller/supervisor cases are in
 * server-action-build-ownership.spec.ts ('R6-1: ...').
 */
jest.setTimeout(15_000);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const send = (socket: Socket, message: object): void => {
  socket.write(JSON.stringify(message) + '\n');
};
/** A reaped child's number: its group is absent (observation only, never signalled). */
const absentGroup = (): number => spawnSync(process.execPath, ['-e', '1']).pid as number;
/** A live group of our own, stopped through its parent-held handle. */
const owned: ChildProcess[] = [];
const liveGroup = (): number => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  owned.push(child);
  return child.pid as number;
};
afterEach(async () => {
  for (const child of owned.splice(0)) signalChild(child, 'SIGKILL');
  await cleanupFixtures();
});

async function peerOf(endpoint: ReturnType<typeof supervisorEndpoint>): Promise<{
  peer: Socket;
  lines: Array<{ id: number; target: string }>;
}> {
  await endpoint.ready;
  const peer = connect(endpoint.path);
  await once(peer, 'connect');
  const lines: Array<{ id: number; target: string }> = [];
  let buffer = '';
  peer.on('data', (data) => {
    buffer += data;
    while (buffer.includes('\n')) {
      lines.push(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as never);
      buffer = buffer.slice(buffer.indexOf('\n') + 1);
    }
  });
  return { peer, lines };
}
const waitFor = async (test: () => boolean): Promise<void> => {
  while (!test()) await sleep(5);
};

describe('R6-1: one acknowledged controller lifecycle', () => {
  it.each(['group', 'root'] as const)(
    '%s: connectivity is not readiness, a write is not an ACK, an ACK is not completion',
    async (target) => {
      const endpoint = supervisorEndpoint(2_000);
      const { peer, lines } = await peerOf(endpoint);
      let settled = false;
      const result =
        target === 'group' ? endpoint.request('group') : endpoint.request('root', 'SIGTERM');
      void result.then(() => (settled = true));
      try {
        await sleep(40);
        expect(lines).toEqual([]); // Connected, but the handler is not installed yet.
        send(peer, { kind: 'READY', group: absentGroup() });
        await waitFor(() => lines.length === 1);
        expect(lines[0]).toMatchObject({ target });
        await sleep(40);
        expect(settled).toBe(false);
        send(peer, { kind: 'ACK', id: lines[0].id, acted: true });
        if (target === 'group') {
          await sleep(40);
          expect(settled).toBe(false);
          send(peer, { kind: 'FINAL' });
          await sleep(40);
          expect(settled).toBe(false); // Announced, but the lifetime has not ended yet.
          peer.end();
        }
        expect(await result).toBe(target === 'group' ? 'COMPLETED' : true);
      } finally {
        peer.destroy();
        await endpoint.close();
      }
    },
  );

  it('a fixture that ended normally is COMPLETED without any command', async () => {
    const endpoint = supervisorEndpoint(2_000);
    const { peer } = await peerOf(endpoint);
    send(peer, { kind: 'READY', group: absentGroup() });
    send(peer, { kind: 'NORMAL_END' });
    peer.end();
    try {
      expect(await endpoint.ended).toBe('COMPLETED');
      expect(await endpoint.request('group')).toBe('COMPLETED');
    } finally {
      await endpoint.close();
    }
  });

  it.each([
    'EOF before READY',
    'controller lost after its ACK, with no ending announced',
    'send failure',
    'startup timeout',
    'missing ACK',
    'ending announced, group still present',
    'malformed reply',
  ])('%s is LOST: cleanup rejects loudly and still drops the fixture', async (fault) => {
    const endpoint = supervisorEndpoint(300);
    // A startup timeout: the endpoint listens, but no controller ever connects.
    const { peer, lines } =
      fault === 'startup timeout' ? { peer: undefined, lines: [] } : await peerOf(endpoint);
    const wrapper = jest.fn(() => true);
    trackFixture({ group: () => endpoint.request('group'), wrapper, close: endpoint.close });
    const write = Socket.prototype.write;
    const spy =
      fault === 'send failure'
        ? jest.spyOn(Socket.prototype, 'write').mockImplementation(function (
            this: Socket,
            ...args: Parameters<Socket['write']>
          ): boolean {
            if (this !== peer && String(args[0]).includes('"target":"group"')) {
              (args.at(-1) as (error: Error) => void)(new Error('modeled send failure'));
              return false;
            }
            return Reflect.apply(write, this, args) as boolean;
          })
        : undefined;
    try {
      if (peer) {
        if (fault === 'EOF before READY') peer.end();
        else if (fault === 'malformed reply') peer.write('not-json\n');
        else {
          const group = fault.startsWith('ending announced') ? liveGroup() : absentGroup();
          send(peer, { kind: 'READY', group });
          if (fault !== 'missing ACK' && fault !== 'send failure') {
            void waitFor(() => lines.length > 0).then(() => {
              send(peer, { kind: 'ACK', id: lines[0].id, acted: true });
              if (fault.startsWith('ending announced')) send(peer, { kind: 'FINAL' });
              peer.end();
            });
          }
        }
      }
      await expect(cleanupFixtures()).rejects.toMatchObject({
        message: 'fixture cleanup failed',
        errors: [expect.objectContaining({ message: LOST_DIAGNOSTIC })],
      });
      expect(wrapper).toHaveBeenCalledWith('SIGKILL');
      expect(await endpoint.ended).toBe('LOST');
      // Removed from the registry even though it failed; the endpoint stays retired.
      await expect(cleanupFixtures()).resolves.toBeUndefined();
      expect(wrapper).toHaveBeenCalledTimes(1);
      expect(await endpoint.request('root', 'SIGTERM')).toBe(false);
    } finally {
      spy?.mockRestore();
      peer?.destroy();
      await endpoint.close();
    }
  });

  it('READY, ACK and completion share ONE deadline', async () => {
    const endpoint = supervisorEndpoint(300);
    const { peer, lines } = await peerOf(endpoint);
    const result = endpoint.request('group');
    // Each stage alone is within 300 ms; together they are not.
    const ready = setTimeout(() => send(peer, { kind: 'READY', group: absentGroup() }), 200);
    void waitFor(() => lines.length > 0).then(() => {
      send(peer, { kind: 'ACK', id: lines[0].id, acted: true });
      send(peer, { kind: 'FINAL' });
    });
    const end = setTimeout(() => peer.end(), 400);
    try {
      expect(await result).toBe('LOST');
    } finally {
      clearTimeout(ready);
      clearTimeout(end);
      peer.destroy();
      await endpoint.close();
    }
  });
});
