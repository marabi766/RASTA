/** @jest-environment node */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  cleanupFixtures,
  commandPath,
  decodeEvent,
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
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
/**
 * The timers this test's code creates through the global `setTimeout` that have neither
 * fired nor been cleared: a count we control, so unrelated runner timers cannot disturb it.
 */
function watchTimers(): { live(): number; restore(): void } {
  const live = new Set<unknown>();
  const create = setTimeout;
  const cancel = clearTimeout;
  const set = jest.spyOn(global, 'setTimeout').mockImplementation(((
    handler: (...args: unknown[]) => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    const timer = create(
      (...fired: unknown[]) => {
        live.delete(timer);
        handler(...fired);
      },
      ms,
      ...args,
    );
    live.add(timer);
    return timer;
  }) as never);
  const clear = jest.spyOn(global, 'clearTimeout').mockImplementation(((timer?: never) => {
    live.delete(timer);
    cancel(timer);
  }) as never);
  return {
    live: () => live.size,
    restore() {
      set.mockRestore();
      clear.mockRestore();
    },
  };
}
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

/**
 * Why a waiter returned. Every waiter ends on one of these, and none can outlive the
 * endpoint it watches: `ended` is the endpoint's own termination, `deadline` its own bound,
 * `cancelled` the join in `stop()`.
 */
type Reason = 'satisfied' | 'ended' | 'deadline' | 'cancelled';

/** A modeled controller: it writes events on `peer` and reads commands from `lines`. */
async function peerOf(endpoint: ReturnType<typeof supervisorEndpoint>): Promise<{
  peer: Socket;
  commands: Socket;
  lines: Array<{ id: number; target: string }>;
  /** Resolves when `test` holds, or when the endpoint ends, or at `ms`, or on `stop()`. */
  until(test: () => boolean, ms?: number): Promise<Reason>;
  /** Background work: `action` runs only if the wait was satisfied. Joined by `stop()`. */
  when(test: () => boolean, action: () => void): void;
  /** Waiters that have not settled yet. */
  pending(): number;
  /** Cancels every waiter and joins all background work. */
  stop(): Promise<void>;
}> {
  await endpoint.ready;
  const peer = connect(endpoint.path);
  await once(peer, 'connect');
  const commands = connect(commandPath(endpoint.path));
  await once(commands, 'connect');
  const lines: Array<{ id: number; target: string }> = [];
  // The endpoint may retire these first; a write to a retired channel is not a test error.
  for (const socket of [peer, commands]) socket.on('error', () => {});
  const waiting = new Set<{ check(): void; cancel(): void }>();
  const background: Array<Promise<unknown>> = [];
  let buffer = '';
  commands.on('data', (data) => {
    buffer += data;
    while (buffer.includes('\n')) {
      lines.push(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as never);
      buffer = buffer.slice(buffer.indexOf('\n') + 1);
    }
    for (const waiter of [...waiting]) waiter.check();
  });
  const until = (test: () => boolean, ms = 5_000): Promise<Reason> =>
    new Promise<Reason>((resolve) => {
      const finish = (reason: Reason): void => {
        clearTimeout(timer);
        waiting.delete(waiter);
        resolve(reason);
      };
      const waiter = {
        check: () => test() && finish('satisfied'),
        cancel: () => finish('cancelled'),
      };
      const timer = setTimeout(() => finish('deadline'), ms);
      void endpoint.ended.then(() => finish('ended'));
      waiting.add(waiter);
      waiter.check();
    });
  return {
    peer,
    commands,
    lines,
    until,
    when(test, action) {
      background.push(until(test).then((reason) => reason === 'satisfied' && action()));
    },
    pending: () => waiting.size,
    async stop() {
      for (const waiter of [...waiting]) waiter.cancel();
      await Promise.all(background.splice(0));
    },
  };
}

describe('R6-1: one acknowledged controller lifecycle', () => {
  it.each(['group', 'root'] as const)(
    '%s: connectivity is not readiness, a write is not an ACK, an ACK is not completion',
    async (target) => {
      const endpoint = supervisorEndpoint(2_000);
      const { peer, commands, lines, until, stop } = await peerOf(endpoint);
      let settled = false;
      const result =
        target === 'group' ? endpoint.request('group') : endpoint.request('root', 'SIGTERM');
      void result.then(() => (settled = true));
      try {
        await sleep(40);
        expect(lines).toEqual([]); // Connected, but the handler is not installed yet.
        send(peer, { kind: 'READY', group: absentGroup() });
        expect(await until(() => lines.length === 1)).toBe('satisfied');
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
        commands.destroy();
        await endpoint.close();
        await stop();
      }
    },
  );

  it('a fixture that ended normally is COMPLETED without any command', async () => {
    const endpoint = supervisorEndpoint(2_000);
    const { peer, commands } = await peerOf(endpoint);
    send(peer, { kind: 'READY', group: absentGroup() });
    send(peer, { kind: 'NORMAL_END' });
    peer.end();
    try {
      expect(await endpoint.ended).toBe('COMPLETED');
      expect(await endpoint.request('group')).toBe('COMPLETED');
    } finally {
      commands.destroy();
      await endpoint.close();
    }
  });

  it('a command write that fails against an announced ending is still COMPLETED', async () => {
    // CI race (r7): cleanup wrote its command just as the supervisor ended normally.
    // The write fails (EPIPE) while NORMAL_END and EOF are still unread. Only the event
    // channel may decide; a shared channel would be destroyed with the unread event.
    const endpoint = supervisorEndpoint(3_000);
    await endpoint.ready;
    const events = JSON.stringify(endpoint.path);
    const peer = spawn(
      process.execPath,
      [
        '-e',
        `const net = require('net');
         const out = net.connect(${events});
         const cmd = net.connect(${JSON.stringify(commandPath(endpoint.path))});
         out.on('connect', () => out.write(JSON.stringify({ kind: 'READY', group: ${absentGroup()} }) + '\\n'));
         cmd.once('data', (d) => {
           out.write(JSON.stringify({ kind: 'ACK', id: JSON.parse(d).id, acted: true }) + '\\n');
           setTimeout(() => out.write(JSON.stringify({ kind: 'NORMAL_END' }) + '\\n', () => process.exit(0)), 200);
         });`,
      ],
      { stdio: 'ignore' },
    );
    owned.push(peer);
    try {
      expect(await endpoint.request('root', 'SIGTERM')).toBe(true);
      // Block this loop while the peer announces its ending and exits, so both the
      // event and the EOF are still unread when the command write hits the closed peer.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
      expect(await endpoint.request('group')).toBe('COMPLETED');
    } finally {
      await endpoint.close();
    }
  });

  it.each([
    'EOF before READY',
    'controller lost after its ACK, with no ending announced',
    'send failure, with no ending announced',
    'startup timeout',
    'missing ACK',
    'ending announced, group still present',
    'malformed reply',
  ])('%s is LOST: cleanup rejects loudly and still drops the fixture', async (fault) => {
    const endpoint = supervisorEndpoint(300);
    // A startup timeout: the endpoint listens, but no controller ever connects.
    const control = fault === 'startup timeout' ? undefined : await peerOf(endpoint);
    const { peer, commands, lines } = control ?? {
      peer: undefined,
      commands: undefined,
      lines: [],
    };
    const wrapper = jest.fn(() => true);
    trackFixture({ group: () => endpoint.request('group'), wrapper, close: endpoint.close });
    const write = Socket.prototype.write;
    const spy = fault.startsWith('send failure')
      ? jest.spyOn(Socket.prototype, 'write').mockImplementation(function (
          this: Socket,
          ...args: Parameters<Socket['write']>
        ): boolean {
          if (this !== commands && String(args[0]).includes('"target":"group"')) {
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
          if (fault !== 'missing ACK' && !fault.startsWith('send failure')) {
            control?.when(
              () => lines.length > 0,
              () => {
                send(peer, { kind: 'ACK', id: lines[0].id, acted: true });
                if (fault.startsWith('ending announced')) send(peer, { kind: 'FINAL' });
                peer.end();
              },
            );
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
      commands?.destroy();
      await endpoint.close();
      await control?.stop();
    }
  });

  it('READY, ACK and completion share ONE deadline', async () => {
    const endpoint = supervisorEndpoint(300);
    const { peer, commands, lines, when, stop } = await peerOf(endpoint);
    const result = endpoint.request('group');
    // Each stage alone is within 300 ms; together they are not.
    const ready = setTimeout(() => send(peer, { kind: 'READY', group: absentGroup() }), 200);
    when(
      () => lines.length > 0,
      () => {
        send(peer, { kind: 'ACK', id: lines[0].id, acted: true });
        send(peer, { kind: 'FINAL' });
      },
    );
    const end = setTimeout(() => peer.end(), 400);
    try {
      expect(await result).toBe('LOST');
    } finally {
      clearTimeout(ready);
      clearTimeout(end);
      peer.destroy();
      commands.destroy();
      await endpoint.close();
      await stop();
    }
  });

  it('a READY that outlasts the deadline is LOST, and no waiter, timer or handle outlives it', async () => {
    // r8 R7-1: READY is sent only after the shared deadline. Timers run in the order of
    // their expiry, however late the loop runs them, so the deadline (100 ms) always fires
    // before the READY timer (200 ms) and no command is ever delivered: nothing here is
    // tuned to a runner's speed.
    const timers = watchTimers();
    const endpoint = supervisorEndpoint(100);
    const { peer, commands, lines, when, pending, stop } = await peerOf(endpoint);
    let acted = false;
    when(
      () => lines.length > 0,
      () => (acted = true),
    ); // The detached waiter: its own deadline is 5 s, so only the endpoint's end can settle it.
    try {
      const result = endpoint.request('group');
      const ready = setTimeout(() => send(peer, { kind: 'READY', group: absentGroup() }), 200);
      try {
        expect(await result).toBe('LOST');
        expect(await endpoint.ended).toBe('LOST');
        await tick();
        expect(lines).toEqual([]);
        // Settled by the endpoint's termination, not by the join below.
        expect(pending()).toBe(0);
      } finally {
        clearTimeout(ready);
        peer.destroy();
        commands.destroy();
        await endpoint.close();
        await stop();
      }
      expect(acted).toBe(false);
      for (const socket of [peer, commands]) if (!socket.closed) await once(socket, 'close');
      // After teardown: no timer of ours is live, both channels are closed, and the
      // endpoint's directory is gone.
      expect(timers.live()).toBe(0);
      expect([peer.closed, commands.closed]).toEqual([true, true]);
      expect(existsSync(dirname(endpoint.path))).toBe(false);
    } finally {
      timers.restore();
    }
  });
});

describe('R7-2: protocol messages are validated in both directions', () => {
  const NORMAL_END = { kind: 'NORMAL_END' };

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '7'],
    ['a string', '"READY"'],
    ['an unknown kind', JSON.stringify({ kind: 'MYSTERY' })],
    ['READY without a group', JSON.stringify({ kind: 'READY' })],
    ['READY with group 0', JSON.stringify({ kind: 'READY', group: 0 })],
    ['READY with a fractional group', JSON.stringify({ kind: 'READY', group: 1.5 })],
    ['READY with an unsafe group', '{"kind":"READY","group":9007199254740993}'],
    ['READY with a string group', JSON.stringify({ kind: 'READY', group: '5' })],
    ['ACK without acted', JSON.stringify({ kind: 'ACK', id: 1 })],
    ['ACK with a string id', JSON.stringify({ kind: 'ACK', id: '1', acted: true })],
    ['ACK with id 0', JSON.stringify({ kind: 'ACK', id: 0, acted: true })],
  ])('%s decodes to nothing', (_name, line) => {
    expect(decodeEvent(line)).toBeUndefined();
  });

  it('valid events decode', () => {
    expect(decodeEvent('{"kind":"READY","group":42}')).toEqual({ kind: 'READY', group: 42 });
    expect(decodeEvent('{"kind":"ACK","id":3,"acted":false}')).toEqual({
      kind: 'ACK',
      id: 3,
      acted: false,
    });
    expect(decodeEvent('{"kind":"FINAL"}')).toEqual({ kind: 'FINAL' });
    expect(decodeEvent('{"kind":"NORMAL_END"}')).toEqual({ kind: 'NORMAL_END' });
  });

  /** Writes raw frames as a controller would, then EOF; the outcome the endpoint reaches. */
  async function outcomeOf(frames: string): Promise<string> {
    const endpoint = supervisorEndpoint(1_000);
    const { peer, commands, stop } = await peerOf(endpoint);
    try {
      peer.write(frames);
      peer.end();
      return await endpoint.ended;
    } finally {
      peer.destroy();
      commands.destroy();
      await endpoint.close();
      await stop();
    }
  }
  const line = (message: unknown): string => JSON.stringify(message) + '\n';

  it('control: READY then NORMAL_END then EOF is COMPLETED', async () => {
    expect(await outcomeOf(line({ kind: 'READY', group: absentGroup() }) + line(NORMAL_END))).toBe(
      'COMPLETED',
    );
  });

  it.each(['null', '[]', 'not-json', '{"kind":"MYSTERY"}', '{"kind":"ACK","id":1}'])(
    'a %s frame after READY is LOST, never a throw or COMPLETED',
    async (garbage) => {
      const group = absentGroup();
      expect(
        await outcomeOf(line({ kind: 'READY', group }) + garbage + '\n' + line(NORMAL_END)),
      ).toBe('LOST');
    },
  );

  it('READY with a negative group is LOST, though its positive twin is absent', async () => {
    // The probe would have checked the (absent) positive number and called it COMPLETED.
    expect(await outcomeOf(line({ kind: 'READY', group: -absentGroup() }) + line(NORMAL_END))).toBe(
      'LOST',
    );
  });

  it.each(['garbage', '{"kind":"FINAL"', '{"kind":"NORMAL_END"}'])(
    'an incomplete frame (%s) at EOF after a valid ending is LOST',
    async (remainder) => {
      expect(
        await outcomeOf(
          line({ kind: 'READY', group: absentGroup() }) + line(NORMAL_END) + remainder,
        ),
      ).toBe('LOST');
    },
  );

  describe('the controller refuses a malformed command', () => {
    const CONTROLLER = pathToFileURL(join(__dirname, 'test/build-controller.mjs')).href;
    // The production supervisor's shape: a 'message' handler, then a lifetime that never ends.
    const SUPERVISOR =
      "process.on('message', () => {}); setInterval(() => {}, 1000); await new Promise(() => {});\n";

    /** Runs the real controller against raw servers; returns what it sent and how it ended. */
    async function drive(
      commandBytes: string,
    ): Promise<{ events: string; alive: boolean; stderr: string }> {
      const dir = mkdtempSync(join(tmpdir(), 'build-control-'));
      const path = join(dir, 'ipc');
      writeFileSync(join(dir, 'supervisor.mjs'), SUPERVISOR);
      let events = '';
      let commands: Socket | undefined;
      let eventsClosed: Promise<void> = Promise.resolve();
      let ready!: () => void;
      const readyFrame = new Promise<void>((resolve) => (ready = resolve));
      let acknowledged!: () => void;
      const ackFrame = new Promise<void>((resolve) => (acknowledged = resolve));
      const eventServer = createServer((socket) => {
        eventsClosed = new Promise((resolve) => socket.once('close', () => resolve()));
        socket.on('error', () => socket.destroy());
        socket.setEncoding('utf8').on('data', (data: string) => {
          events += data;
          if (events.includes('"READY"')) ready();
          if (events.includes('"ACK"')) acknowledged();
        });
      });
      const commandServer = createServer((socket) => {
        commands = socket;
        socket.on('error', () => socket.destroy());
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const within = <T>(promise: Promise<T>): Promise<T> =>
        Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('controller did not respond')), 10_000);
          }),
        ]).finally(() => clearTimeout(timer));
      let child: ChildProcess | undefined;
      try {
        await Promise.all([
          new Promise<void>((resolve) => eventServer.listen(path, resolve)),
          new Promise<void>((resolve) => commandServer.listen(`${path}.commands`, resolve)),
        ]);
        let stderr = '';
        child = spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { supervise } from ${JSON.stringify(CONTROLLER)};
             await supervise(${JSON.stringify(path)}, ${JSON.stringify(pathToFileURL(join(dir, 'supervisor.mjs')).href)});`,
          ],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
        owned.push(child);
        child.stderr?.setEncoding('utf8').on('data', (data: string) => (stderr += data));
        await within(readyFrame);
        commands?.write(commandBytes);
        if (!commandBytes.endsWith('\n')) commands?.end(); // An incomplete frame, then EOF.
        await within(Promise.race([eventsClosed, ackFrame]));
        // Two more turns: a crash on a bad command would be visible by now.
        await tick();
        return { events, alive: child.exitCode === null && child.signalCode === null, stderr };
      } finally {
        if (child) signalChild(child, 'SIGKILL');
        commands?.destroy();
        for (const server of [eventServer, commandServer])
          await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('control: a valid group command is acknowledged and the channel stays open', async () => {
      const result = await drive(line({ id: 1, target: 'group' }));
      expect(result.events).toContain('{"kind":"ACK","id":1,"acted":true}');
      expect(result.stderr).toBe('');
      expect(result.alive).toBe(true);
    });

    it.each([
      ['null', 'null\n'],
      ['not-json', 'not-json\n'],
      ['an array', '[]\n'],
      ['an unknown target', line({ id: 1, target: 'mystery' })],
      ['a non-positive id', line({ id: -1, target: 'group' })],
      ['a missing id', line({ target: 'group' })],
      ['a root command without a signal', line({ id: 1, target: 'root' })],
      ['a root command with an unknown signal', line({ id: 1, target: 'root', signal: 'SIGNOPE' })],
      ['an inherited signal name', line({ id: 1, target: 'root', signal: 'toString' })],
      ['an incomplete frame at EOF', '{"id":1,"target":"group"}'],
    ])('%s: no action, no ACK, the event channel ends and nothing throws', async (_name, bytes) => {
      const result = await drive(bytes);
      expect(result.events).not.toContain('"ACK"');
      expect(result.stderr).toBe('');
      expect(result.alive).toBe(true);
    });
  });
});
