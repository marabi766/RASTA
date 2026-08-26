import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Sliding-window rate limiting backed by Redis.
 *
 * A fixed window lets a caller send `2 × limit` requests across a window
 * boundary — half at the end of one window, half at the start of the next —
 * which defeats the point of the limit at exactly the moment it matters. A
 * sliding window counts only the trailing period.
 *
 * The counter lives in Redis rather than in process memory because the gateway
 * runs several replicas; an in-memory counter would multiply every limit by the
 * replica count.
 */

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Unix seconds when the window frees up. */
  resetAt: number;
  retryAfterSeconds: number;
}

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

/**
 * Sorted-set sliding window, run as one atomic script.
 *
 * Doing this as separate round trips would let concurrent requests each read
 * an under-limit count and all be admitted.
 */
const SLIDING_WINDOW_SCRIPT = `
local key          = KEYS[1]
local now_ms       = tonumber(ARGV[1])
local window_ms    = tonumber(ARGV[2])
local limit        = tonumber(ARGV[3])
local member       = ARGV[4]

-- Drop entries that have aged out of the trailing window.
redis.call('ZREMRANGEBYSCORE', key, 0, now_ms - window_ms)

local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now_ms, member)
  -- Expiry is a safety net: an idle key should not linger forever.
  redis.call('PEXPIRE', key, window_ms)
  return {1, limit - count - 1, 0}
end

-- Refused. The window frees up when the oldest entry ages out.
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry_ms = window_ms
if oldest[2] then
  retry_ms = (tonumber(oldest[2]) + window_ms) - now_ms
  if retry_ms < 0 then retry_ms = 0 end
end

return {0, 0, retry_ms}
`;

@Injectable()
export class RateLimiter implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimiter.name);
  private readonly redis: Redis;
  private scriptSha?: string;
  private counter = 0;

  constructor(
    redisUrl: string,
    private readonly keyPrefix: string,
    /**
     * When Redis is unreachable: allow traffic through (`true`) or refuse it.
     *
     * Defaults to allowing. Rate limiting protects against overload and abuse,
     * but a Redis blip should not take the whole platform offline — that
     * converts a degradation into an outage. Abuse protection still exists at
     * the edge gateway and in per-service authorization.
     */
    private readonly failOpen = true,
  ) {
    this.redis = new Redis(redisUrl, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
    });

    this.redis.on('error', (error) => {
      // Logged at warn, not error: a transient reconnect is expected and this
      // path is designed to degrade rather than fail.
      this.logger.warn(`Redis unavailable for rate limiting: ${error.message}`);
    });
  }

  async consume(scope: string, identifier: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const key = `${this.keyPrefix}:rl:${scope}:${identifier}`;
    const now = Date.now();
    const windowMs = rule.windowSeconds * 1000;

    // Unique per request so two calls in the same millisecond both count.
    const member = `${now}-${(this.counter = (this.counter + 1) % 1_000_000)}`;

    try {
      const result = (await this.evalScript(key, [
        String(now),
        String(windowMs),
        String(rule.limit),
        member,
      ])) as [number, number, number];

      const [allowed, remaining, retryMs] = result;

      return {
        allowed: allowed === 1,
        limit: rule.limit,
        remaining,
        resetAt: Math.ceil((now + (retryMs || windowMs)) / 1000),
        retryAfterSeconds: Math.ceil(retryMs / 1000),
      };
    } catch (error) {
      this.logger.warn(
        `Rate limit check failed (${(error as Error).message}); ` +
          `${this.failOpen ? 'allowing' : 'refusing'} the request`,
      );

      return {
        allowed: this.failOpen,
        limit: rule.limit,
        remaining: this.failOpen ? rule.limit : 0,
        resetAt: Math.ceil((now + windowMs) / 1000),
        retryAfterSeconds: this.failOpen ? 0 : rule.windowSeconds,
      };
    }
  }

  /**
   * Runs the script by SHA, falling back to a full EVAL when Redis has not
   * seen it (a restart clears the script cache). Saves sending the script body
   * on every single request.
   */
  private async evalScript(key: string, args: string[]): Promise<unknown> {
    if (!this.scriptSha) {
      this.scriptSha = (await this.redis.script('LOAD', SLIDING_WINDOW_SCRIPT)) as string;
    }

    try {
      return await this.redis.evalsha(this.scriptSha, 1, key, ...args);
    } catch (error) {
      if ((error as Error).message.includes('NOSCRIPT')) {
        this.scriptSha = undefined;
        return this.redis.eval(SLIDING_WINDOW_SCRIPT, 1, key, ...args);
      }
      throw error;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}
