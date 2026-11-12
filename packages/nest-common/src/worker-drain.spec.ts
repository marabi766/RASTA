import { WorkerBoundary } from './worker-boundary';
import { WorkerDrain } from './worker-drain';

it('exposes a snapshot of raw pending outcomes and drains them without caller opt-in', async () => {
  const worker = new WorkerBoundary(jest.fn());
  let reject!: (error: Error) => void;
  let resolve!: () => void;
  const failed = worker.run(
    () =>
      new Promise<void>((_yes, no) => {
        reject = no;
      }),
  );
  const sibling = worker.run(
    () =>
      new Promise<void>((yes) => {
        resolve = yes;
      }),
  );
  const snapshot = worker.pendingOutcomes;
  expect(snapshot).toEqual([failed, sibling]);
  const drain = new WorkerDrain(worker, { stop: async () => undefined }, jest.fn());
  let stopped = false;
  const outcome = drain
    .stop()
    .catch((error: unknown) => error)
    .finally(() => {
      stopped = true;
    });
  const failure = new Error('direct failure');
  reject(failure);
  await expect(failed).rejects.toBe(failure);
  expect(stopped).toBe(false);
  expect(worker.pendingOutcomes).toEqual([sibling]);
  expect(snapshot).toEqual([failed, sibling]);
  resolve();
  expect(await outcome).toBe(failure);
  expect(worker.pendingOutcomes).toEqual([]);
});
