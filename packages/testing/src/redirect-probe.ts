import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RedirectProbe {
  baseUrl: string;
  /** Captured before any test replaces global fetch. */
  fetch: typeof fetch;
  recover(): void;
  sent: { method: string; headers: IncomingHttpHeaders; url: string }[];
  target: { headers: IncomingHttpHeaders }[];
}

/** Two real HTTP origins: the second would answer with a caller-valid body. */
export async function withRedirectProbe(
  options: {
    body: unknown;
    status?: number;
    sameOrigin?: boolean;
    /** Successful first page, followed by a redirect on the second exchange. */
    firstPage?: unknown;
    /** Observe the original exchange at the server, before its response is sent. */
    onRequest?: (request: RedirectProbe['sent'][number], body: string) => void;
  },
  run: (probe: RedirectProbe) => Promise<void>,
): Promise<void> {
  let status = options.status ?? 302;
  const sent: RedirectProbe['sent'] = [];
  const target: RedirectProbe['target'] = [];
  const servers: Server[] = [];
  const serve = async (server: Server): Promise<string> => {
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  try {
    const targetUrl = await serve(
      createServer((req, res) => {
        target.push({ headers: req.headers });
        req.resume();
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify(options.body));
      }),
    );
    const baseUrl = await serve(
      createServer((req, res) => {
        if (req.url === '/redirect-target') {
          req.resume();
          target.push({ headers: req.headers });
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(options.body));
          return;
        }
        const request = { method: req.method ?? '', headers: req.headers, url: req.url ?? '' };
        sent.push(request);
        const respond = (): void => {
          if (options.firstPage !== undefined && sent.length === 1) {
            res
              .writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify(options.firstPage));
            return;
          }
          res
            .writeHead(status, {
              location: options.sameOrigin ? '/redirect-target' : `${targetUrl}/redirect-target`,
              'content-type': 'application/json',
            })
            .end(
              JSON.stringify(
                status === 200
                  ? options.body
                  : { code: 'NOT_FOUND', message: 'redirect-body-must-not-be-trusted' },
              ),
            );
        };
        if (options.onRequest) {
          const chunks: Buffer[] = [];
          req.on('data', (chunk: Buffer) => chunks.push(chunk));
          req.on('end', () => {
            options.onRequest?.(request, Buffer.concat(chunks).toString('utf8'));
            respond();
          });
          req.on('error', () => res.destroy());
        } else {
          req.resume();
          respond();
        }
      }),
    );
    await run({
      baseUrl,
      fetch: globalThis.fetch,
      sent,
      target,
      recover: () => {
        status = 200;
      },
    });
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections();
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      ),
    );
  }
}

export const REDIRECT_CASES = [301, 302, 303, 307, 308].flatMap((status) =>
  [false, true].map((sameOrigin) => ({ status, sameOrigin })),
);
