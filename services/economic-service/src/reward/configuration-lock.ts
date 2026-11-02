import type { ExtendedPrismaClient } from '../prisma/prisma.service';

// One platform-wide namespace includes global rules and every tenant. Readers
// share it; infrequent admin writers serialize. No rule-row existence required.
const REWARD_CONFIGURATION_LOCK = 5451209;

export async function lockRewardConfiguration(
  tx: ExtendedPrismaClient,
  mode: 'read' | 'write',
): Promise<void> {
  if (mode === 'write') {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${REWARD_CONFIGURATION_LOCK})::text`;
  } else {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(${REWARD_CONFIGURATION_LOCK})::text`;
  }
}
