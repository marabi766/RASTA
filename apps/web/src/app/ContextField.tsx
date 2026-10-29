import { CONTEXT_PARAM } from '@/lib/page-context';

/**
 * The hidden field every GET form carries, so the URL it submits to is bound
 * to the organization the page was drawn for (`server/page-context.ts`; PR 405
 * review 2, F2). Without it the page it lands on reads none of the query.
 */
export function ContextField({ context }: { readonly context: string }) {
  return <input type="hidden" name={CONTEXT_PARAM} value={context} />;
}
