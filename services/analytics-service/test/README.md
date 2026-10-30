Analytics tests use a real disposable PostGIS database. Bootstrap it and apply analytics migrations first.
Set `DATABASE_URL_ANALYTICS` to its runtime login and `DATABASE_URL_ANALYTICS_MIGRATOR` to its owner login.
Run ordinary suites with `pnpm --filter @rasta/analytics-service test:integration --runInBand`.

The separate `test:db-privileges` integration project creates scratch databases, proves a superuser
cannot bypass the migration role guard, seeds forbidden extension column UPDATE, and applies the
splitter's actual extension cleanup. Export `TEST_ANALYTICS_ADMIN_URL` only for this task (and for
`test:coverage`, which runs all projects). See the commented disposable example in `.env.migrator.example`.
Missing admin configuration fails closed. Never put it in the runtime `.env` or a shared turbo task,
and never export it in a shell that starts a service: every service refuses to boot with it — or with
any database URL whose user is not a service's runtime role — in its environment
(`assertNoMigratorCredentials`, @rasta/config).

Run `pnpm --filter @rasta/analytics-service test:db-privileges --runInBand` locally. CI gives the admin URL
only to the analytics privilege and coverage steps; ordinary service integration tasks never receive it.
