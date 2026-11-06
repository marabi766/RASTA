import 'reflect-metadata';
import { StrictQueryParserInstaller } from '@rasta/nest-common';
import { AppModule } from './app.module';

// Express's default parser drops every query segment past the 1000th without a
// word; AppModule must install the strict one (FU-072). Guarded repo-wide by
// scripts/strict-query-parser-wiring.test.mjs.
it('AppModule provides the strict query parser installer (FU-072)', () => {
  expect(Reflect.getMetadata('providers', AppModule)).toContain(StrictQueryParserInstaller);
});
