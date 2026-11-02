import { createTransport } from 'nodemailer';
import { inspect } from 'node:util';
import { SmtpMailChannel } from './smtp.mail.channel';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
const transport = jest.mocked(createTransport);
const options = {
  host: 'private-sentinel-79',
  port: 25,
  secure: false,
  user: 'private-sentinel-79',
  password: 'JZ97-another-secret',
  fromAddress: 'rasta@example.invalid',
  fromName: 'Rasta',
  timeoutMs: 1000,
  deliversToRealRecipients: false,
};
const secret = () =>
  Object.assign(new Error('private-sentinel-79 JZ97-another-secret'), {
    name: 'PrivateSentinel79',
    code: 'JZ97_ANOTHER_SECRET',
    cause: new Error('private-sentinel-79'),
  });

test('SMTP construction/send/health failures report closed categories only', async () => {
  transport.mockImplementation(() => {
    throw secret();
  });
  const smtp = new SmtpMailChannel(options);
  const report = await smtp.send({
    to: 'a@example.invalid',
    subject: 'test',
    html: 'test',
    text: 'test',
  });
  expect(report).toMatchObject({
    outcome: 'TRANSIENT_FAILURE',
    failureReason: 'CONNECTION_FAILED',
  });
  expect(await smtp.health()).toMatchObject({ available: false, detail: 'CONNECTION_FAILED' });
  expect(inspect(report, { showHidden: true, depth: 10 })).not.toMatch(/sentinel|JZ97/i);
});

test('SMTP disconnect cannot throw a raw SDK error to startup/shutdown reporting', async () => {
  transport.mockReturnValue({
    verify: async () => undefined,
    close: () => {
      throw secret();
    },
  } as never);
  const smtp = new SmtpMailChannel(options);
  await smtp.health();
  const failure: unknown = await smtp.onModuleDestroy().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(String(failure)).toContain('SMTP_HOST: mail transport close failed (code unknown)');
  expect(inspect(failure, { showHidden: true, depth: 10 })).not.toMatch(/sentinel|JZ97/i);
});
