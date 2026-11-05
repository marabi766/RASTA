import { Logger } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PassThrough, Readable } from 'node:stream';
import { inspect } from 'node:util';
import { ObjectStorageError, S3ObjectStorage } from './s3.storage';
import { ObjectChangedError } from './storage.port';

jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }));
const options = {
  endpoint: 'http://localhost:9000',
  region: 'local',
  accessKeyId: 'private-sentinel-79',
  secretAccessKey: 'JZ97-another-secret',
  bucket: 'documents',
  forcePathStyle: true,
};
const SENTINEL = /sentinel|JZ97|another.secret/i;
const foreign = () =>
  Object.assign(new Error('private-sentinel-79 JZ97-another-secret'), {
    name: 'JZ97AnotherSecret',
    code: 'PRIVATE_SENTINEL_79',
    input: options.secretAccessKey,
    cause: new Error(options.accessKeyId),
  });
const send = jest.spyOn(S3Client.prototype, 'send');
const sign = jest.mocked(getSignedUrl);
const calls = [
  [
    'createUploadUrl',
    (s: S3ObjectStorage) =>
      s.createUploadUrl({
        objectKey: 'x',
        contentType: 'application/pdf',
        contentLength: 1,
        expiresInSeconds: 60,
      }),
  ],
  [
    'copyToSealedKey',
    (s: S3ObjectStorage) =>
      s.copyToSealedKey({ sourceKey: 'x', destinationKey: 'y', ifMatchETag: 'etag' }),
  ],
  [
    'createDownloadUrl',
    (s: S3ObjectStorage) =>
      s.createDownloadUrl({
        objectKey: 'x',
        contentType: 'application/pdf',
        downloadFilename: 'x',
        expiresInSeconds: 60,
      }),
  ],
  ['head', (s: S3ObjectStorage) => s.head('x')],
  ['readPrefix', (s: S3ObjectStorage) => s.readPrefix('x', 10)],
  ['openReadStream', (s: S3ObjectStorage) => s.openReadStream({ objectKey: 'x', maxBytes: 10 })],
  ['remove', (s: S3ObjectStorage) => s.remove('x')],
] as const;

function safe(error: unknown): void {
  expect(error).toBeInstanceOf(ObjectStorageError);
  expect(inspect(error, { depth: 10, showHidden: true })).not.toMatch(SENTINEL);
  expect((error as Error).cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toMatch(SENTINEL);
}

beforeEach(() => {
  send.mockReset();
  sign.mockReset();
});

test.each([
  'data:private-sentinel-79:JZ97-another-secret',
  `http://${['private-sentinel-79', 'JZ97-another-secret'].join(':')}@localhost:9000`,
  'http://localhost:bad/private-sentinel-79/JZ97-another-secret',
])('refuses an invalid S3_ENDPOINT before SDK use: %s', (endpoint) => {
  let failure: unknown;
  try {
    new S3ObjectStorage({ ...options, endpoint });
  } catch (error) {
    failure = error;
  }
  safe(failure);
  expect((failure as ObjectStorageError).code).toBe('INVALID_ENDPOINT');
  expect(send).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled();
});

test.each(calls)('%s discards every foreign error property', async (_name, call) => {
  send.mockRejectedValue(foreign() as never);
  sign.mockRejectedValue(foreign());
  const error: unknown = await call(new S3ObjectStorage(options)).catch((e: unknown) => e);
  safe(error);
  expect((error as ObjectStorageError).code).toBe('unknown');
});

test('health reports false with a fixed category and code', async () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  send.mockRejectedValue(foreign() as never);
  try {
    await expect(new S3ObjectStorage(options).isHealthy()).resolves.toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(SENTINEL);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('S3_ENDPOINT: object storage failed (code unknown)'),
    );
  } finally {
    warn.mockRestore();
  }
});

test.each([{ name: 'NotFound' }, { name: 'NoSuchKey' }, { $metadata: { httpStatusCode: 404 } }])(
  'head preserves absence for %j',
  async (error) => {
    send.mockRejectedValue(Object.assign(foreign(), error) as never);
    await expect(new S3ObjectStorage(options).head('x')).resolves.toBeNull();
  },
);

test.each([{ name: 'PreconditionFailed' }, { $metadata: { httpStatusCode: 412 } }])(
  'copy preserves the changed-object refusal for %j',
  async (error) => {
    send.mockRejectedValue(Object.assign(foreign(), error) as never);
    const result: unknown = await new S3ObjectStorage(options)
      .copyToSealedKey({ sourceKey: 'x', destinationKey: 'y', ifMatchETag: 'e' })
      .catch((e: unknown) => e);
    expect(result).toBeInstanceOf(ObjectChangedError);
    expect(inspect(result, { depth: 10 })).not.toMatch(SENTINEL);
  },
);

test('prefix collection sanitizes a delayed body failure', async () => {
  send.mockResolvedValue({
    Body: {
      transformToWebStream: () =>
        new ReadableStream({
          pull() {
            throw foreign();
          },
        }),
    },
  } as never);
  safe(await new S3ObjectStorage(options).readPrefix('x', 10).catch((e: unknown) => e));
});

test('a prefix read keeps at most the asked bytes when storage ignores the range (PR #722 r1 F1)', async () => {
  let pulls = 0;
  let cancelled = false;
  send.mockResolvedValue({
    Body: {
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls += 1;
              controller.enqueue(new Uint8Array(4).fill(pulls));
            },
            cancel() {
              cancelled = true;
            },
          },
          { highWaterMark: 0 },
        ),
    },
  } as never);
  const prefix = await new S3ObjectStorage(options).readPrefix('x', 10);
  expect([...prefix]).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3]);
  expect(pulls).toBe(3);
  expect(cancelled).toBe(true);
});

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test('delayed stream failures are sanitized and close the SDK socket', async () => {
  const body = new PassThrough();
  send.mockResolvedValue({ Body: body } as never);
  const stream = await new S3ObjectStorage(options).openReadStream({
    objectKey: 'x',
    maxBytes: 10,
  });
  const result = collect(stream).catch((e: unknown) => e);
  body.write(Buffer.from('abc'));
  body.destroy(foreign());
  safe(await result);
  safe(stream.errored);
  expect(body.destroyed).toBe(true);
});

test('byte ceiling fails closed and destroys the SDK socket', async () => {
  const body = Readable.from([Buffer.from('abc'), Buffer.from('de')]);
  send.mockResolvedValue({ Body: body } as never);
  const stream = await new S3ObjectStorage(options).openReadStream({ objectKey: 'x', maxBytes: 4 });
  await expect(collect(stream)).rejects.toThrow('exceeded the byte ceiling');
  expect(body.destroyed).toBe(true);
});

test('a complete stream at the ceiling is intact; early consumer close destroys the source', async () => {
  const body = Readable.from([Buffer.from('abcd')]);
  send.mockResolvedValue({ Body: body } as never);
  const storage = new S3ObjectStorage(options);
  expect(await collect(await storage.openReadStream({ objectKey: 'x', maxBytes: 4 }))).toEqual(
    Buffer.from('abcd'),
  );
  const pending = new PassThrough();
  send.mockResolvedValue({ Body: pending } as never);
  const stream = await storage.openReadStream({ objectKey: 'x', maxBytes: 4 });
  stream.destroy();
  await new Promise<void>((resolve) => stream.once('close', resolve));
  expect(pending.destroyed).toBe(true);
});

test('S3 construction discards a foreign failure before exposing the adapter', () => {
  let failure: unknown;
  try {
    new S3ObjectStorage({
      ...options,
      get region(): never {
        throw foreign();
      },
    });
  } catch (error) {
    failure = error;
  }
  safe(failure);
});

test('an asynchronous SDK destroy failure stays contained after consumer cancellation', async () => {
  const body = new Readable({
    read(): void {},
    destroy(_error, done): void {
      setImmediate(() => done(foreign()));
    },
  });
  send.mockResolvedValue({ Body: body } as never);
  const stream = await new S3ObjectStorage(options).openReadStream({
    objectKey: 'x',
    maxBytes: 10,
  });
  stream.on('error', () => undefined);
  const closed = new Promise<void>((resolve) => body.once('close', resolve));
  stream.destroy();
  await closed;
  expect(body.destroyed).toBe(true);
  expect(body.listenerCount('error')).toBe(0);
});
