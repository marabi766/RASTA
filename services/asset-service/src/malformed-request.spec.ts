import { Body, Controller, Module, Param, Post, type INestApplication } from '@nestjs/common';
import { APP_FILTER, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Logger } from '@rasta/logging';
import { AllExceptionsFilter, EXCEPTION_FILTER_LOGGER } from '@rasta/nest-common';

/**
 * S-09 through a real Nest app wired as this service wires it (`APP_FILTER`
 * with the shared `AllExceptionsFilter`, `useBodyParser('json')` as in
 * `main.ts`): a request Nest cannot parse is answered, and logged, in fixed
 * words — never the parser's, which quote the client's bytes.
 */

const SENTINEL = 'SENTINEL-2b8f-national-id-0055512345';

@Controller('probe')
class ProbeController {
  @Post()
  accept(@Body() body: unknown): unknown {
    return body;
  }

  @Post(':id')
  acceptFor(@Param('id') id: string): unknown {
    return { id };
  }
}

const lines: unknown[] = [];
const record = (...args: unknown[]) => {
  lines.push(args);
};
const logger = { debug: record, info: record, warn: record, error: record } as unknown as Logger;

@Module({
  controllers: [ProbeController],
  providers: [
    { provide: EXCEPTION_FILTER_LOGGER, useValue: logger },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
class ProbeModule {}

describe('a request Nest cannot parse (S-09, real app)', () => {
  let app: INestApplication;
  let base: string;

  beforeAll(async () => {
    const created = await NestFactory.create<NestExpressApplication>(ProbeModule, {
      logger: false,
    });
    created.useBodyParser('json', { limit: '256kb' });
    await created.listen(0, '127.0.0.1');
    const address = created.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
    app = created;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    lines.length = 0;
  });

  it('negative control: the parser’s own message quotes the sentinel', () => {
    let message = '';
    try {
      JSON.parse(`{"nationalId": ${SENTINEL}}`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('SENTINEL');
  });

  it.each([
    ['a bare value', `{"nationalId": ${SENTINEL}}`],
    ['a truncated body', `{"nationalId": "${SENTINEL}`],
    ['trailing bytes', `{"ok": 1} ${SENTINEL}`],
  ])(
    'a malformed JSON body (%s): fixed 400, nothing of the body in the answer or the log',
    async (_case, raw) => {
      const response = await fetch(`${base}/probe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: raw,
      });
      const text = await response.text();

      expect(response.status).toBe(400);
      expect(JSON.parse(text)).toMatchObject({
        code: 'VALIDATION_FAILED',
        message: 'The request body is not valid JSON',
      });
      expect(text).not.toContain('SENTINEL');
      expect(lines).toHaveLength(1);
      expect(JSON.stringify(lines)).not.toContain('SENTINEL');
    },
  );

  it('a malformed percent-encoding in the path: fixed 400 as well', async () => {
    const response = await fetch(`${base}/probe/${SENTINEL}%E0%A4%A`, { method: 'POST' });
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(text)).toMatchObject({ message: 'The request could not be read' });
    expect(JSON.stringify(lines)).not.toContain('URI malformed');
  });

  it('a body over the limit: 413 PAYLOAD_TOO_LARGE, not a 500', async () => {
    const response = await fetch(`${base}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: `${SENTINEL}${'x'.repeat(300 * 1024)}` }),
    });
    const text = await response.text();

    expect(response.status).toBe(413);
    expect(JSON.parse(text)).toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'The request body is too large',
    });
    expect(text).not.toContain('SENTINEL');
    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  it.each([
    [
      'an unsupported charset',
      { 'content-type': `application/json; charset=${SENTINEL.toLowerCase()}` },
      'The request body is in a charset this service does not accept',
    ],
    [
      'an unsupported content encoding',
      { 'content-type': 'application/json', 'content-encoding': SENTINEL.toLowerCase() },
      'The request body is in a content encoding this service does not accept',
    ],
  ])('%s: 415 UNSUPPORTED_MEDIA_TYPE, without echoing it', async (_case, headers, message) => {
    const response = await fetch(`${base}/probe`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ok: true }),
    });
    const text = await response.text();

    expect(response.status).toBe(415);
    expect(JSON.parse(text)).toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE', message });
    expect(text.toLowerCase()).not.toContain('sentinel');
    expect(JSON.stringify(lines).toLowerCase()).not.toContain('sentinel');
  });

  it('a well-formed body still reaches the handler', async () => {
    const response = await fetch(`${base}/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
  });
});
