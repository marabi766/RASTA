import { Test } from '@nestjs/testing';
import { ENV } from '../tokens';
import { PrismaService } from '../prisma/prisma.service';
import { RfqEvidenceRepository } from './rfq-evidence.repository';
import { RfqGapMonitor } from './rfq-gap-monitor';
import { SamplingLoop } from './sampling-loop';
import { TenderEvidenceRepository } from './tender-evidence.repository';
import { TenderGapMonitor } from './tender-gap-monitor';

/**
 * Shutdown ordering (Codex on #590, F3): a gap sample whose first query is still running when
 * the application closes must finish **before** the database client disconnects. Nest runs the
 * providers' destroy hooks concurrently, so the proof is a real Nest module closed for real —
 * the monitor's own async hook alone would pass a test that only calls it.
 */

const SUMMARY = [{ held: 0n, overdue: 0n, oldest: null }];

/** A database whose first query is held until the test releases it, and which counts what runs after `$disconnect`. */
function slowDatabase() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const state = { queries: 0, queriesAfterDisconnect: 0, disconnected: false };
  const client = {
    $connect: async () => undefined,
    $disconnect: async () => {
      state.disconnected = true;
    },
    $queryRaw: async () => {
      state.queries += 1;
      if (state.disconnected) state.queriesAfterDisconnect += 1;
      if (state.queries === 1) {
        await gate;
        return SUMMARY;
      }
      return [];
    },
  };
  return { client, state, release };
}

describe.each([
  ['RFQ', RfqGapMonitor, RfqEvidenceRepository, { AUDIT_RFQ_GAP_ALERT_SECONDS: 300 }],
  ['tender', TenderGapMonitor, TenderEvidenceRepository, { AUDIT_TENDER_GAP_ALERT_SECONDS: 300 }],
] as const)('the %s gap monitor at shutdown', (_name, Monitor, Repository, env) => {
  it('finishes the sample in flight before the database disconnects: no query after $disconnect', async () => {
    const { client, state, release } = slowDatabase();
    const prisma = new PrismaService('postgresql://nobody:nothing@127.0.0.1:1/none');
    Object.defineProperty(prisma, 'client', { value: client });
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ENV, useValue: env },
        Repository,
        Monitor,
      ],
    }).compile();
    await moduleRef.init(); // the monitor starts its first sample: query 1 is held
    expect(state.queries).toBe(1);

    const closing = moduleRef.close(); // every destroy hook, concurrently
    await new Promise((resolve) => setImmediate(resolve));
    // The client must still be connected while the sample is in flight.
    expect(state.disconnected).toBe(false);

    release();
    await closing;

    expect(state.disconnected).toBe(true);
    expect(state.queries).toBe(2); // the sample ran to its end...
    expect(state.queriesAfterDisconnect).toBe(0); // ...before the client went away
  });
});

describe('SamplingLoop', () => {
  it('stops scheduling: no sample starts once stopped', async () => {
    jest.useFakeTimers();
    try {
      const sample = jest.fn(async () => undefined);
      const loop = new SamplingLoop(sample, 1_000);
      loop.start();
      expect(sample).toHaveBeenCalledTimes(1);
      const stopped = loop.stop();
      await jest.advanceTimersByTimeAsync(5_000);
      await stopped;
      expect(sample).toHaveBeenCalledTimes(1);
      loop.start(); // a stopped loop stays stopped
      await jest.advanceTimersByTimeAsync(5_000);
      expect(sample).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('waits for a bounded time only: a sample that never ends does not hold the shutdown', async () => {
    const loop = new SamplingLoop(() => new Promise<void>(() => undefined), 60_000, 25);
    loop.start();
    const began = Date.now();
    await loop.stop();
    expect(Date.now() - began).toBeLessThan(2_000);
  });

  it('does not overlap a slow sample with the next tick', async () => {
    jest.useFakeTimers();
    try {
      let release!: () => void;
      const sample = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const loop = new SamplingLoop(sample, 1_000);
      loop.start();
      await jest.advanceTimersByTimeAsync(3_000);
      expect(sample).toHaveBeenCalledTimes(1);
      release();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(sample).toHaveBeenCalledTimes(2);
      release();
      await loop.stop();
    } finally {
      jest.useRealTimers();
    }
  });
});
