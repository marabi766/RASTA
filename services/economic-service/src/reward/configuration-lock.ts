import type { ExtendedPrismaClient } from '../prisma/prisma.service';
import { lockReadCommitted } from '../prisma/read-committed-lock';

// One platform-wide namespace includes global rules and every tenant. Readers
// share it; infrequent admin writers serialize. No rule-row existence required.
const REWARD_CONFIGURATION_LOCK = BigInt(5451209);

export async function lockRewardConfiguration(
  tx: ExtendedPrismaClient,
  mode: 'read' | 'write',
): Promise<void> {
  await lockReadCommitted(tx, REWARD_CONFIGURATION_LOCK, mode === 'write' ? 'exclusive' : 'shared');
}
