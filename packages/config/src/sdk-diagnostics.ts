/**
 * Refuse ioredis tracing before construction: DEBUG is cached by the SDK and
 * can print AUTH arguments before an error listener runs. Conservative prefix
 * matching also refuses wildcard families and does not trust negative patterns.
 * This applies in every environment; credentials are sensitive outside production too.
 */
export function assertRedisDiagnosticsSafe(): void {
  const unsafe = (process.env.DEBUG ?? '').split(/[\s,]+/).some((pattern) => {
    if (!pattern || pattern.startsWith('-')) return false;
    const prefix = pattern.split('*', 1)[0] ?? '';
    return prefix.startsWith('ioredis') || 'ioredis'.startsWith(prefix);
  });
  if (unsafe) throw new Error('REDIS_URL: SDK tracing refused (DEBUG)');
}

/** Called before every Temporal connection, even after its runtime is installed. */
export function assertTemporalDiagnosticsSafe(): void {
  if (process.env.GRPC_TRACE || process.env.GRPC_VERBOSITY) {
    throw new Error('TEMPORAL_ADDRESS: SDK tracing refused (GRPC_TRACE/GRPC_VERBOSITY)');
  }
}

/**
 * ioredis writes an INFO/NOPERM reply directly to console.warn in `_readyCheck`,
 * bypassing error events. Reduce that reply before its callback reaches the SDK.
 * Keep NOPERM's existing skip-ready-check decision; all other replies pass through.
 */
export function protectRedisReadyCheck(redis: object): void {
  const info: unknown = Reflect.get(redis, 'info');
  if (typeof info !== 'function') return;
  Reflect.set(
    redis,
    'info',
    new Proxy(info, {
      apply(target, receiver, args: unknown[]): unknown {
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          args[args.length - 1] = (error: unknown, result: unknown): unknown => {
            let noperm = false;
            try {
              const message = (error as { message?: unknown } | null)?.message;
              noperm = typeof message === 'string' && message.includes('NOPERM');
            } catch {
              // An unreadable failure is reported through the ordinary error-event boundary.
            }
            return callback(
              noperm
                ? new Error('NOPERM (REDIS_URL: Redis readiness diagnostic, code NOPERM)')
                : error,
              result,
            );
          };
        }
        return Reflect.apply(target, receiver, args);
      },
    }),
  );
}
