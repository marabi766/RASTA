import { Injectable, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { RastaError } from '../errors/rasta-error';
import { parse } from 'node:querystring';

/**
 * The most `&`-separated segments a query string may carry — empty ones
 * included, counted the way `querystring` splits them.
 */
export const MAX_QUERY_SEGMENTS = 1000;

/**
 * A query parser that never truncates silently (PR 699 review F1, FU-072).
 *
 * Express's default `simple` parser is `querystring.parse` with its default
 * `maxKeys: 1000`: segment 1001 onwards is dropped without a word, so
 * `"&".repeat(1000) + "organizationId=ORG-A"` arrived as an empty query — the
 * filter gone and the whole directory answered — and 800 empties followed by
 * 201 ids slipped past the 200-id bound. Here the segments are counted first;
 * over the bound is a `400 VALIDATION_FAILED`, and under it everything is
 * parsed (`maxKeys: 0`), so every supplied value reaches the DTO's validation.
 *
 * Throws from the lazy `req.query` getter, i.e. inside Nest's handler
 * pipeline, where the exception filter turns it into the standard envelope.
 * Shared by every HTTP service's AppModule (FU-072).
 */
export function strictQueryParser(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  let segments = 1;
  for (let i = 0; i < raw.length; i += 1) if (raw.charCodeAt(i) === 0x26) segments += 1;
  if (segments > MAX_QUERY_SEGMENTS) {
    throw RastaError.validation([
      {
        path: 'query',
        code: 'QUERY_TOO_MANY_SEGMENTS',
        message: `A query string may carry at most ${MAX_QUERY_SEGMENTS} parameters`,
      },
    ]);
  }
  return parse(raw, '&', '=', { maxKeys: 0 });
}

/**
 * Installs {@link strictQueryParser} on the Express instance. A provider of
 * `AppModule` rather than a line in `main.ts`, so the API test harness — which
 * boots the real `AppModule` — exercises the very wiring production runs.
 * Without an HTTP adapter (a module compiled with no application) there is no
 * query string to parse, and nothing to install.
 */
@Injectable()
export class StrictQueryParserInstaller implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const adapter = this.adapterHost.httpAdapter;
    if (!adapter) return;
    (adapter.getInstance() as { set(name: string, value: unknown): void }).set(
      'query parser',
      strictQueryParser,
    );
  }
}
