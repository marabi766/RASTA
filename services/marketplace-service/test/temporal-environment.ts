import { mkdir } from 'node:fs/promises';
import { TestWorkflowEnvironment } from '@temporalio/testing';

export async function createTemporalTestEnvironment(): Promise<TestWorkflowEnvironment> {
  const downloadDir = process.env.TEMPORAL_TEST_SERVER_DIR;
  if (process.env.CI && !downloadDir) {
    throw new Error('Temporal specs in CI require TEMPORAL_TEST_SERVER_DIR');
  }
  // cached-download fetches a missing executable; ensure a cold cache has a directory.
  if (downloadDir) await mkdir(downloadDir, { recursive: true });
  return TestWorkflowEnvironment.createTimeSkipping({
    server: { executable: { type: 'cached-download', downloadDir, ttl: '30 days' } },
  });
}
