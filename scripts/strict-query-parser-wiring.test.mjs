// -----------------------------------------------------------------------------
// Every HTTP service installs @rasta/nest-common's strict query parser (FU-072).
//
//   pnpm test:strict-query-parser-wiring
//
// Express's default parser drops every query segment past the 1000th without a
// word, so a filter, cursor or bound hidden behind padding silently vanished.
// Each service with a src/main.ts must name StrictQueryParserInstaller in its
// AppModule and carry src/app.module.query-parser.spec.ts, which asserts the
// provider through Nest's own metadata. A new service fails here until it does.
// -----------------------------------------------------------------------------
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const servicesDir = join(import.meta.dirname, '..', 'services');
const services = readdirSync(servicesDir).filter((name) =>
  existsSync(join(servicesDir, name, 'src', 'main.ts')),
);

test('the scan finds the services (an empty scan is no gate)', () => {
  assert.ok(services.length >= 17, `found only ${services.length} services`);
});

for (const name of services) {
  test(`${name} installs the strict query parser`, () => {
    const src = join(servicesDir, name, 'src');
    const appModule = readFileSync(join(src, 'app.module.ts'), 'utf8');
    assert.match(
      appModule,
      /^ {4}StrictQueryParserInstaller,$/m,
      'AppModule providers must list it',
    );
    const spec = join(src, 'app.module.query-parser.spec.ts');
    assert.ok(existsSync(spec), `${name} lacks src/app.module.query-parser.spec.ts`);
    assert.match(readFileSync(spec, 'utf8'), /toContain\(StrictQueryParserInstaller\)/);
  });
}
