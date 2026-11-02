import Link from 'next/link';

import {
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  IsolatedText,
  NoAccessState,
  Section,
  TableScroll,
} from '@/ui';
import { formatJalaliDateLong, toPersianDigits } from '@/lib/format';
import { formatQuantity } from '@/lib/inventory-fields';
import type { ReadResult, StockPage, WarehousePage, WarehouseSummary } from '@/server/inventory';
import { withContext, type InContext } from '@/lib/page-context';

/**
 * Warehouses and their stock levels (docs/16 § ۱۶٫۶, `/inventory`). Read-only.
 *
 * A pure function of what the server read, like `ProjectsScreen`: every state
 * is renderable in a test. The chosen warehouse and both cursors live in the
 * URL, so no JavaScript is involved and a view is a link somebody can send.
 *
 * Quantities are the service's own whole numbers, shown as given; "available"
 * is not recomputed here. The product is shown by its opaque id — inventory
 * does not resolve it (Q-105) and neither does the portal.
 */

export interface InventoryQuery {
  /** The chosen warehouse, already checked to be shaped like a warehouse id. */
  readonly warehouse?: string;
  /** Paging of the warehouse list. */
  readonly warehouseCursor?: string;
  /** Paging of the stock of the chosen warehouse. */
  readonly cursor?: string;
}

/** The chosen warehouse and what was read for it. Absent when none is chosen. */
export interface InventorySelection {
  readonly warehouse: ReadResult<WarehouseSummary>;
  /** `null` when the warehouse itself could not be read, so stock was not asked for. */
  readonly stock: ReadResult<StockPage> | null;
}

export interface InventoryScreenProps {
  readonly warehouses: ReadResult<WarehousePage>;
  readonly selection: InventorySelection | null;
  readonly query: InContext<InventoryQuery>;
}

export function inventoryHref(
  query: InContext<InventoryQuery>,
  changes: Partial<InventoryQuery>,
): string {
  const merged = { ...query, ...changes };
  const params = new URLSearchParams();
  if (merged.warehouse) params.set('warehouse', merged.warehouse);
  if (merged.warehouseCursor) params.set('wcursor', merged.warehouseCursor);
  if (merged.cursor) params.set('cursor', merged.cursor);
  const text = params.toString();
  return withContext(query.context, text ? `/inventory?${text}` : '/inventory');
}

export function InventoryScreen({ warehouses, selection, query }: InventoryScreenProps) {
  return (
    <div className="flex flex-col gap-6">
      <WarehousesSection result={warehouses} query={query} />
      {selection ? <StockSection selection={selection} query={query} /> : null}
    </div>
  );
}

function WarehousesSection({
  result,
  query,
}: {
  result: ReadResult<WarehousePage>;
  query: InContext<InventoryQuery>;
}) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="انبارهای این سازمان در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="انباری یافت نشد" description="این نشست سازمان فعالی ندارد." />;
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="فهرست انبارها خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;

  return (
    <Section headingId="warehouses" title="انبارها">
      {page.items.length === 0 ? (
        <EmptyState title="انباری نیست" description="این سازمان هنوز انباری ثبت نکرده است." />
      ) : (
        <>
          <p className="mb-3 text-sm text-content-muted">
            {toPersianDigits(String(page.items.length))} انبار در این صفحه
          </p>
          <ul className="flex flex-col gap-3">
            {page.items.map((warehouse) => (
              <li
                key={warehouse.id}
                className="rounded-lg border border-border bg-surface-raised p-4"
              >
                <Link
                  href={inventoryHref(query, { warehouse: warehouse.id, cursor: undefined })}
                  aria-current={warehouse.id === query.warehouse ? 'page' : undefined}
                  className="font-medium underline"
                >
                  <IsolatedText>{warehouse.name}</IsolatedText>
                </Link>
                <p className="mt-1 text-sm text-content-muted">
                  شناسه <Identifier>{warehouse.id}</Identifier> · ثبت‌شده در{' '}
                  {formatJalaliDateLong(warehouse.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}

      {page.nextCursor ? (
        <div className="mt-4">
          <ButtonLink
            href={inventoryHref(query, { warehouseCursor: page.nextCursor })}
            tone="secondary"
          >
            انبارهای بعدی
          </ButtonLink>
        </div>
      ) : null}
    </Section>
  );
}

function StockSection({
  selection,
  query,
}: {
  selection: InventorySelection;
  query: InContext<InventoryQuery>;
}) {
  const { warehouse, stock } = selection;

  if (warehouse.kind === 'FORBIDDEN') {
    return <NoAccessState description="موجودی این انبار در اختیار شما نیست." />;
  }

  if (warehouse.kind === 'NOT_FOUND') {
    return <EmptyState title="انبار یافت نشد" description="انبار درخواستی در این سازمان نیست." />;
  }

  if (warehouse.kind === 'UNAVAILABLE' || warehouse.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="انبار خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={warehouse.correlationId}
      />
    );
  }

  const title = <IsolatedText>{warehouse.data.name}</IsolatedText>;

  return (
    <Section headingId="stock" title={<>موجودی انبار {title}</>}>
      <StockBody stock={stock} query={query} />
    </Section>
  );
}

function StockBody({
  stock,
  query,
}: {
  stock: ReadResult<StockPage> | null;
  query: InContext<InventoryQuery>;
}) {
  if (stock === null) return null;

  if (stock.kind === 'FORBIDDEN') {
    return <NoAccessState description="موجودی این انبار در اختیار شما نیست." />;
  }

  if (stock.kind === 'NOT_FOUND') {
    return <EmptyState title="موجودی یافت نشد" description="انبار درخواستی در این سازمان نیست." />;
  }

  if (stock.kind === 'UNAVAILABLE' || stock.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="موجودی انبار خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={stock.correlationId}
      />
    );
  }

  const page = stock.data;

  if (page.items.length === 0) {
    return (
      <EmptyState title="موجودی‌ای نیست" description="در این انبار هنوز کالایی ثبت نشده است." />
    );
  }

  return (
    <>
      <TableScroll label="موجودی کالاها در انبار">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">موجودی کالاها در انبار</caption>
          <thead>
            <tr className="border-b border-border text-start text-content-muted">
              <th scope="col" className="p-3 text-start font-medium">
                کالا
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                موجود
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                رزروشده
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                قابل‌استفاده
              </th>
              <th scope="col" className="p-3 text-start font-medium">
                آخرین تغییر
              </th>
            </tr>
          </thead>
          <tbody>
            {page.items.map((item) => (
              <tr key={item.id} className="border-b border-border">
                <td className="p-3">
                  <Identifier>{item.productId}</Identifier>
                </td>
                <td className="p-3">{formatQuantity(item.onHandQuantity)}</td>
                <td className="p-3">{formatQuantity(item.reservedQuantity)}</td>
                <td className="p-3 font-medium">{formatQuantity(item.availableQuantity)}</td>
                <td className="p-3 text-content-muted">{formatJalaliDateLong(item.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>

      {page.nextCursor ? (
        <div className="mt-4">
          <ButtonLink href={inventoryHref(query, { cursor: page.nextCursor })} tone="secondary">
            صفحهٔ بعد
          </ButtonLink>
        </div>
      ) : null}
    </>
  );
}
