import type { NestExpressApplication } from '@nestjs/platform-express';
import { MAX_CONTENT_BYTES } from '@rasta/sealing';

/**
 * How much of a JSON body the service reads, as sent; above it, 413. The same 256 KiB as the gateway
 * in front of it (pinned in `body-parser.spec.ts`), so both doors refuse the same bodies, and as the
 * seal.
 *
 * A transport guard, not a contract: each command's schema holds its own limit (a quotation:
 * `QUOTATION_BODY_MAX_BYTES`) and a refusal there names the rule. No limit can promise that every
 * body reaches its schema, since whitespace and escapes make any spelling longer. It stands above
 * every body a command's bounds allow in text of up to 2 bytes a character, so Persian and Latin
 * text is always judged; only a quotation of text that averages more than 2.5 bytes a character,
 * far over its budget, can meet the 413 instead.
 */
export const JSON_BODY_LIMIT_BYTES = MAX_CONTENT_BYTES;

/** The one parser configuration: `main.ts` and the integration harness both call this. */
export function useProcurementBodyParser(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT_BYTES });
}
