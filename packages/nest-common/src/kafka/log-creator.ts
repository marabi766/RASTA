import type { logCreator as KafkaLogCreator } from 'kafkajs';
import { createLogger, scrubMessage, type Logger } from '@rasta/logging';
import { scrubLogValue } from '../logging/nest-logger';

/**
 * KafkaJS's own logger. Without a `logCreator` it writes to `console` — an
 * error with its message and stack as they are: a SCRAM failure or a transport
 * error can carry a credential, and nothing caps the record. This one routes
 * every KafkaJS line through @rasta/logging, so the message and each extra
 * field (an `error`, a `stack`, a broker address) are scrubbed and capped like
 * any other line.
 *
 * Supplied by {@link kafkaClientConfig}, so a client built from it cannot
 * forget it; `kafka-log-creator.guard.spec.ts` fails any `new Kafka(` that
 * does not take that configuration.
 */
const LEVELS: Record<number, 'error' | 'warn' | 'info' | 'debug'> = {
  1: 'error',
  2: 'warn',
  4: 'info',
  5: 'debug',
};

export function kafkaLogCreator(clientId: string): KafkaLogCreator {
  // Built on the first line: most clients never log, and the destination is
  // picked when pino is created.
  let logger: Logger | undefined;

  return () =>
    ({ namespace, level, log }) => {
      try {
        logger ??= createLogger({ serviceName: clientId });
        const { message, timestamp: _timestamp, ...extra } = log as Record<string, unknown>;
        const fields = scrubLogValue(extra) as Record<string, unknown>;
        logger[LEVELS[level] ?? 'info'](
          { ...fields, component: 'kafkajs', namespace },
          scrubMessage(String(message)),
        );
      } catch {
        // A log call must not throw into KafkaJS's retry loop.
      }
    };
}
