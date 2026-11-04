/** Hostile N1 access paths, outside the linted E2E trees so runtime is tested independently. */
type Holder = { request: unknown };
export const REQUEST_CONTEXT_ROUTES = {
  'parameter destructuring': ({ request }: Holder): unknown => request,
  'assignment destructuring': (holder: Holder): unknown => {
    let request: unknown = null;
    ({ request } = holder);
    return request;
  },
  'Reflect.get': (holder: Holder): unknown => Reflect.get(holder, 'request'),
};

/** Raw factory route for regressions: deliberately avoids the harness proxy. */
export async function rawContextFromFactory(playwright: {
  request: { newContext(): Promise<unknown> };
}): Promise<unknown> {
  return playwright.request.newContext();
}
