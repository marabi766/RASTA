/**
 * A service's shutdown wiring, read from its AppModule without a database or a
 * broker (D-052 phase 4b, Codex r1 on #293).
 *
 * `runOutboxShutdownProvider` calls the `OutboxShutdown` provider's own factory
 * — the object the AppModule's `@Module` declares — with a stand-in for every
 * participant it injects, stops it twice, and reports each participant's stop:
 * its deadline, and which stops had already returned when it began.
 * `publisherCloseProblems` reads from that whether the Kafka publisher is
 * closed as `OutboxShutdown` must close it: once, last, after every other
 * participant's stop has returned, by the same deadline.
 */

/** The `OutboxShutdown` factory provider, as `Reflect.getMetadata('providers', AppModule)` lists it. */
export interface ShutdownFactoryProvider {
  inject?: unknown[];
  useFactory: (...args: unknown[]) => unknown;
}

export interface ParticipantStop {
  /** The injection token of the participant. */
  token: unknown;
  deadlineAt?: number;
  /** The participants whose stop had returned when this one began. */
  after: unknown[];
}

export async function runOutboxShutdownProvider(
  provider: ShutdownFactoryProvider,
  options: { env: unknown; envToken: unknown },
): Promise<ParticipantStop[]> {
  const stops: ParticipantStop[] = [];
  const returned: unknown[] = [];
  const args = (provider.inject ?? []).map((token) =>
    token === options.envToken
      ? options.env
      : {
          stop: async (stopOptions?: { deadlineAt?: number }): Promise<void> => {
            stops.push({ token, deadlineAt: stopOptions?.deadlineAt, after: [...returned] });
            // A stop that takes a turn, so one begun beside it cannot pass for one begun after.
            await new Promise((resolve) => setImmediate(resolve));
            returned.push(token);
          },
        },
  );
  const shutdown = provider.useFactory(...args) as { stop(): Promise<void> };
  await shutdown.stop();
  // A repeated stop — onApplicationShutdown's — joins the first.
  await shutdown.stop();
  return stops;
}

/** What is wrong with how the publisher is closed; empty when nothing is. */
export function publisherCloseProblems(
  stops: readonly ParticipantStop[],
  publisherToken: unknown,
): string[] {
  const problems: string[] = [];
  const name = (token: unknown): string =>
    typeof token === 'function' ? token.name : String(token);
  const publisher = stops.filter((stop) => stop.token === publisherToken);
  if (publisher.length !== 1) {
    problems.push(`the publisher is stopped ${publisher.length} time(s), not once`);
    return problems;
  }
  const [close] = publisher;
  const others = stops.filter((stop) => stop.token !== publisherToken);
  if (others.length === 0) problems.push('nothing is drained before the publisher');
  for (const other of others) {
    if (!close!.after.includes(other.token)) {
      problems.push(`the publisher is closed before ${name(other.token)}'s stop returned`);
    }
  }
  const deadlines = new Set(stops.map((stop) => stop.deadlineAt));
  if (deadlines.size !== 1 || close!.deadlineAt === undefined) {
    problems.push(
      `the participants do not share one deadline: ${[...deadlines].map(String).join(', ')}`,
    );
  }
  for (const token of new Set(stops.map((stop) => stop.token))) {
    if (stops.filter((stop) => stop.token === token).length > 1) {
      problems.push(`${name(token)} is stopped more than once`);
    }
  }
  return problems;
}
