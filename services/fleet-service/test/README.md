# fleet-service integration tests

Files matching `*.int-spec.ts` run against **real infrastructure** — a real
PostgreSQL, and for the event tests a real Kafka broker. Nothing here mocks the
database or the broker, because the properties being tested are exactly the
ones a mock would assume rather than verify: a partial unique index refusing a
concurrent insert, a transaction rolling an outbox row back with the state
change it accompanied, a consumer skipping a redelivered event.

Unlike the services written before it, `pnpm test:integration` here does **not**
pass `--passWithNoTests`. The repository has already lived through an
integration stage that was green because it was empty (`PROJECT_MEMORY.md`
§ 19); the flag is what made that possible, so it is absent by design. Deleting
the last test in this directory will fail the build, which is the intended
behaviour.

## Running them

```bash
pnpm infra:up
pnpm --filter @rasta/fleet-service db:migrate
pnpm --filter @rasta/fleet-service test:integration
```

`DATABASE_URL_FLEET` must be set; the root `.env` provides it. Tests that need
a broker read `KAFKA_BROKERS` and **skip themselves with a printed reason** if
it is absent, rather than failing — a developer without Docker should still be
able to run the database half. A skip is visible in the output; silently
passing is not.

## Isolation between tests

Each test file writes rows under identifiers it generates itself and cleans up
after itself in `afterAll`. No test depends on another's leftovers or on
execution order (AGENTS.md § 5), which is why they can run with `--runInBand`
against one shared database without interfering.
