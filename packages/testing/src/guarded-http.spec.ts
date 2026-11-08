import {
  guardEveryRequestContext,
  installRequestContextGuard,
  RedirectRefusedError,
  type GuardableRequestContext,
} from './guarded-http';

const SENDERS = ['delete', 'fetch', 'get', 'head', 'patch', 'post', 'put'] as const;
function fixture(status = 200) {
  const send = jest.fn(async (_url: unknown, _options?: object) => ({
    status: () => status,
    dispose: jest.fn(async () => undefined),
  }));
  class Context {
    dispose = jest.fn(async () => undefined);
  }
  for (const name of SENDERS)
    Object.defineProperty(Context.prototype, name, { value: send, configurable: true });
  const make = (): GuardableRequestContext & Context =>
    new Context() as GuardableRequestContext & Context;
  return { Context, make, send };
}

describe('request class redirect guard', () => {
  it.each([301, 302, 303, 307, 308])(
    'refuses %i on every sender, before and after installation',
    async (status) => {
      const { make, send } = fixture(status);
      const before = make();
      guardEveryRequestContext(before);
      for (const context of [before, make()]) {
        for (const name of SENDERS) {
          // The structural transport type deliberately uses never for compatibility with Playwright.
          await expect(
            context[name]('http://loopback.test' as never, { maxRedirects: 9 } as never),
          ).rejects.toBeInstanceOf(RedirectRefusedError);
          expect(send).toHaveBeenLastCalledWith('http://loopback.test', { maxRedirects: 0 });
          const response = await send.mock.results.at(-1)!.value;
          expect(response.dispose).toHaveBeenCalledTimes(1);
        }
      }
    },
  );

  it.each([200, 204, 300, 304, 305, 404, 500])(
    'preserves %i, receiver and caller options; installation is idempotent',
    async (status) => {
      const { Context, make, send } = fixture(status);
      class Derived extends Context {}
      const context = new Derived() as ReturnType<typeof make>;
      guardEveryRequestContext(context);
      const once: unknown = Reflect.get(Context.prototype, 'post');
      guardEveryRequestContext(make());
      expect(Reflect.get(Context.prototype, 'post')).toBe(once);
      const response = await context.post('url' as never, { data: 'bytes' } as never);
      expect(response.status()).toBe(status);
      expect(send.mock.contexts.at(-1)).toBe(context);
      expect(send).toHaveBeenLastCalledWith('url', { data: 'bytes', maxRedirects: 0 });
      expect(response.dispose).not.toHaveBeenCalled();
      await context.dispose();
      expect(context.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['missing', 'accessor', 'immutable', 'own', 'plain', 'null prototype'])(
    'aborts setup for an unsupported shape: %s',
    (shape) => {
      const { Context, make } = fixture();
      const context = make();
      if (shape === 'missing') Reflect.deleteProperty(Context.prototype, 'post');
      if (shape === 'accessor')
        Object.defineProperty(Context.prototype, 'post', { get: () => context.get });
      if (shape === 'immutable')
        Object.defineProperty(Context.prototype, 'post', { configurable: false });
      if (shape === 'own') Object.defineProperty(context, 'post', { value: context.post });
      const sample =
        shape === 'plain' ? {} : shape === 'null prototype' ? Object.create(null) : context;
      expect(() => guardEveryRequestContext(sample as GuardableRequestContext)).toThrow(
        /guardEveryRequestContext/,
      );
    },
  );

  it('disposes the installation sample on success and failure', async () => {
    const { make } = fixture();
    const sample = make();
    await installRequestContextGuard({ newContext: async () => sample });
    expect(sample.dispose).toHaveBeenCalledTimes(1);
    const bad = { dispose: jest.fn(async () => undefined) };
    await expect(
      installRequestContextGuard({
        newContext: async () => bad as unknown as typeof sample,
      }),
    ).rejects.toThrow(/guardEveryRequestContext/);
    expect(bad.dispose).toHaveBeenCalledTimes(1);
  });
});

// PR #492 N1: these syntax escapes still reach the guarded class.
it.each([301, 302, 303, 307, 308])('N1 indirect contexts refuse %i', async (status) => {
  const { make, send } = fixture(status);
  const page = { request: make() };
  guardEveryRequestContext(page.request);
  const parameter = ({ request }: typeof page): typeof request => request;
  let assigned: GuardableRequestContext = make();
  ({ request: assigned } = page);
  for (const request of [parameter(page), assigned, Reflect.get(page, 'request')]) {
    await expect(request.post('url' as never)).rejects.toBeInstanceOf(RedirectRefusedError);
    expect(send).toHaveBeenLastCalledWith('url', { maxRedirects: 0 });
  }
});
