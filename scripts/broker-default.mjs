import { setTimeout as delay } from 'node:timers/promises';

// Kafka 3.9 ConfigCommand refuses DELETE before sending when its describe says
// the override is absent. This is NOT a successful compensation write.
export const BROKER_DEFAULT_ALREADY_ABSENT = Symbol('broker default already absent');

export function brokerDefaultDeleteOutcome({ status, stdout, stderr }) {
  if (status === 0) return;
  if (
    status === 1 &&
    stdout.trim() === '' &&
    stderr.trim() === 'Invalid config(s): message.max.bytes'
  ) {
    return BROKER_DEFAULT_ALREADY_ABSENT;
  }
  throw new Error('broker default deletion unconfirmed');
}

/** Restore value AND provenance, including a setup write whose response was lost. */
export async function withBrokerDefault(bytes, work, { read, set, pause = delay }) {
  const before = await read();
  let reconciliationRequired = false;
  try {
    if (bytes !== before) {
      // Record the attempt BEFORE sending: failure does not prove refusal.
      reconciliationRequired = true;
      await set(bytes);
    }
    // Work can also alter the default, even when setup was a no-op.
    reconciliationRequired = true;
    return await work();
  } finally {
    if (reconciliationRequired) await restore(before, read, set, pause);
  }
}

async function restore(before, read, set, pause) {
  // Never let a stale matching describe suppress the compensating write.
  // undefined means DELETE the override, not pin the inherited numeric value.
  let writeConfirmed = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!writeConfirmed) {
      try {
        const result = await set(before);
        if (result !== BROKER_DEFAULT_ALREADY_ABSENT) writeConfirmed = true;
      } catch {
        // Retry the idempotent compensation. A stale read alone cannot resolve
        // an unconfirmed restoration write any more than an unconfirmed setup.
      }
    }
    try {
      if (writeConfirmed && (await read()) === before) return;
    } catch {
      // Transient/unreadable describes are not confirmation; retry boundedly.
    }
    if (attempt < 19) await pause(500);
  }
  throw new Error('BROKER_DEFAULT restoration UNCONFIRMED');
}
