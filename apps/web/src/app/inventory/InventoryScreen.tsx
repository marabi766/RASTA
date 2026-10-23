import Link from 'next/link';

import {
  Alert,
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  IsolatedText,
  NoAccessState,
  Section,
  StatusBadge,
  TableScroll,
} from '@/ui';
import { formatJalaliDateLong, toPersianDigits } from '@/lib/format';
import {
  INVENTORY_DONE_MESSAGES,
  INVENTORY_NO_STOCK_FOR_ADJUSTMENT,
  INVENTORY_READ_ONLY_NOTE,
  movementTypeLabel,
  shipmentStatusLabel,
  type InventoryCommand,
  type InventoryScope,
} from '@/lib/inventory-commands';
import { formatQuantity } from '@/lib/inventory-fields';
import type { Binding } from '@/lib/unresolved-order';
import type {
  MovementPage,
  ReadResult,
  ShipmentPage,
  StockPage,
  WarehousePage,
  WarehouseSummary,
} from '@/server/inventory';

import type { AdjustableItem } from './InventoryCommandForm';
import { InventoryCommands, type OfferedInventoryCommand } from './InventoryCommands';

/**
 * Warehouses, their stock levels, the ledger and the shipments (docs/16
 * § ۱۶٫۶, `/inventory`), and — when `write` is given — the operator commands
 * of inventory-service (`InventoryCommands`).
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
  /** Paging of the ledger of the chosen warehouse. */
  readonly movementCursor?: string;
  /** Paging of the shipments. */
  readonly shipmentCursor?: string;
}

/** The chosen warehouse and what was read for it. Absent when none is chosen. */
export interface InventorySelection {
  readonly warehouse: ReadResult<WarehouseSummary>;
  /** `null` when the warehouse itself could not be read, so stock was not asked for. */
  readonly stock: ReadResult<StockPage> | null;
  /** The warehouse's ledger, newest first; absent where it was not asked for. */
  readonly movements?: ReadResult<MovementPage> | null;
}

/**
 * What the commands need, all of it chosen by the server: whether this viewer
 * is an operator (`mayOperateInventory`), the forms the page offers each with
 * a fresh submission, and the browser-side binding. Absent: no command UI.
 */
export interface InventoryWriteView {
  readonly canOperate: boolean;
  readonly csrfToken: string;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  /** A new warehouse. */
  readonly warehouseForms: readonly OfferedInventoryCommand[];
  /** A receipt, an adjustment and a new shipment of the chosen warehouse. */
  readonly selectionForms: readonly OfferedInventoryCommand[];
  /** The command a signed flash confirms just happened, if any. */
  readonly notice?: InventoryCommand;
  readonly pageHref: string;
}

export interface InventoryScreenProps {
  readonly warehouses: ReadResult<WarehousePage>;
  readonly selection: InventorySelection | null;
  readonly query: InventoryQuery;
  readonly shipments?: ReadResult<ShipmentPage> | null;
  readonly write?: InventoryWriteView;
}

export function inventoryHref(query: InventoryQuery, changes: Partial<InventoryQuery>): string {
  const merged = { ...query, ...changes };
  const params = new URLSearchParams();
  if (merged.warehouse) params.set('warehouse', merged.warehouse);
  if (merged.warehouseCursor) params.set('wcursor', merged.warehouseCursor);
  if (merged.cursor) params.set('cursor', merged.cursor);
  if (merged.movementCursor) params.set('mcursor', merged.movementCursor);
  if (merged.shipmentCursor) params.set('scursor', merged.shipmentCursor);
  const text = params.toString();
  return text ? `/inventory?${text}` : '/inventory';
}

export function InventoryScreen({
  warehouses,
  selection,
  query,
  shipments = null,
  write,
}: InventoryScreenProps) {
  return (
    <div className="flex flex-col gap-6">
      {write?.notice ? <Alert tone="success">{INVENTORY_DONE_MESSAGES[write.notice]}</Alert> : null}
      <WarehousesSection result={warehouses} query={query} write={write} />
      {selection ? <StockSection selection={selection} query={query} write={write} /> : null}
      {selection?.movements ? (
        <MovementsSection result={selection.movements} query={query} />
      ) : null}
      {shipments ? <ShipmentsSection result={shipments} query={query} /> : null}
    </div>
  );
}

function WarehousesSection({
  result,
  query,
  write,
}: {
  result: ReadResult<WarehousePage>;
  query: InventoryQuery;
  write?: InventoryWriteView;
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
      {write ? (
        <div className="mb-4">
          <CommandsOrNote
            write={write}
            scope={{ kind: 'WAREHOUSES' }}
            offered={write.warehouseForms}
          />
        </div>
      ) : null}
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
  write,
}: {
  selection: InventorySelection;
  query: InventoryQuery;
  write?: InventoryWriteView;
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
  // The forms are drawn only for a warehouse and a stock list the service answered:
  // with the service degraded, or the list refused, nothing is offered.
  const items = stock?.kind === 'OK' ? stock.data.items : null;

  return (
    <Section headingId="stock" title={<>موجودی انبار {title}</>}>
      {write && items ? (
        <div className="mb-4 flex flex-col gap-2">
          {items.length === 0 && write.canOperate ? (
            <p className="text-sm text-content-muted">{INVENTORY_NO_STOCK_FOR_ADJUSTMENT}</p>
          ) : null}
          <CommandsOrNote
            write={write}
            scope={{ kind: 'WAREHOUSE', warehouseId: warehouse.data.id }}
            offered={write.selectionForms}
            items={items}
          />
        </div>
      ) : null}
      <StockBody stock={stock} query={query} />
    </Section>
  );
}

/** The forms of a slot, or the fixed note to a viewer the service would refuse. */
function CommandsOrNote({
  write,
  scope,
  offered,
  items,
}: {
  write: InventoryWriteView;
  scope: InventoryScope;
  offered: readonly OfferedInventoryCommand[];
  items?: readonly AdjustableItem[];
}) {
  if (!write.canOperate) {
    return <p className="text-sm text-content-muted">{INVENTORY_READ_ONLY_NOTE}</p>;
  }
  return (
    <InventoryCommands
      scope={scope}
      offered={offered}
      csrfToken={write.csrfToken}
      binding={write.binding}
      sessionMaxAgeSeconds={write.sessionMaxAgeSeconds}
      items={items}
      pageHref={write.pageHref}
    />
  );
}

function MovementsSection({
  result,
  query,
}: {
  result: ReadResult<MovementPage>;
  query: InventoryQuery;
}) {
  if (result.kind === 'FORBIDDEN') {
    return (
      <Section headingId="movements" title="دفتر حرکت موجودی">
        <NoAccessState description="دفتر حرکت موجودی این انبار در اختیار شما نیست." />
      </Section>
    );
  }
  if (result.kind === 'NOT_FOUND') return null;
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <Section headingId="movements" title="دفتر حرکت موجودی">
        <ErrorState
          description="دفتر حرکت موجودی خوانده نشد. کمی بعد دوباره تلاش کنید."
          correlationId={result.correlationId}
        />
      </Section>
    );
  }

  const page = result.data;
  return (
    <Section headingId="movements" title="دفتر حرکت موجودی">
      {page.items.length === 0 ? (
        <EmptyState title="حرکتی ثبت نشده" description="هنوز موجودی این انبار تغییری نکرده است." />
      ) : (
        <>
          <p className="mb-3 text-sm text-content-muted">
            دفتر فقط افزوده می‌شود: هر حرکت مقدار تغییر و موجودی پس از آن را نشان می‌دهد، تازه‌ترین
            بالا.
          </p>
          <TableScroll label="حرکت‌های موجودی انبار">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">حرکت‌های موجودی انبار</caption>
              <thead>
                <tr className="border-b border-border text-start text-content-muted">
                  <th scope="col" className="p-3 text-start font-medium">
                    نوع
                  </th>
                  <th scope="col" className="p-3 text-start font-medium">
                    کالا
                  </th>
                  <th scope="col" className="p-3 text-start font-medium">
                    تغییر موجودی
                  </th>
                  <th scope="col" className="p-3 text-start font-medium">
                    موجودی پس از آن
                  </th>
                  <th scope="col" className="p-3 text-start font-medium">
                    مرجع
                  </th>
                  <th scope="col" className="p-3 text-start font-medium">
                    زمان
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((movement) => (
                  <tr key={movement.id} className="border-b border-border">
                    <td className="p-3">
                      {movementTypeLabel(movement.type)}
                      {movement.bySystem ? (
                        <span className="text-content-muted"> (خودکار)</span>
                      ) : null}
                    </td>
                    <td className="p-3">
                      <Identifier>{movement.stockItemId}</Identifier>
                    </td>
                    <td className="p-3">{formatDelta(movement.onHandDelta)}</td>
                    <td className="p-3">{formatQuantity(movement.onHandAfter)}</td>
                    <td className="p-3">
                      {movement.sourceReference ? (
                        <Identifier>{movement.sourceReference}</Identifier>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="p-3 text-content-muted">
                      {formatJalaliDateLong(movement.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </>
      )}
      {page.nextCursor ? (
        <div className="mt-4">
          <ButtonLink
            href={inventoryHref(query, { movementCursor: page.nextCursor })}
            tone="secondary"
          >
            حرکت‌های قدیمی‌تر
          </ButtonLink>
        </div>
      ) : null}
    </Section>
  );
}

/** A signed change as Persian digits with an explicit sign: «+۵» or «−۵». */
function formatDelta(delta: number): string {
  if (delta === 0) return formatQuantity(0);
  return `${delta > 0 ? '+' : '−'}${formatQuantity(Math.abs(delta))}`;
}

function ShipmentsSection({
  result,
  query,
}: {
  result: ReadResult<ShipmentPage>;
  query: InventoryQuery;
}) {
  if (result.kind === 'FORBIDDEN') {
    return (
      <Section headingId="shipments" title="محموله‌ها">
        <NoAccessState description="محموله‌های این سازمان در اختیار شما نیست." />
      </Section>
    );
  }
  if (result.kind === 'NOT_FOUND') return null;
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <Section headingId="shipments" title="محموله‌ها">
        <ErrorState
          description="فهرست محموله‌ها خوانده نشد. کمی بعد دوباره تلاش کنید."
          correlationId={result.correlationId}
        />
      </Section>
    );
  }

  const page = result.data;
  return (
    <Section headingId="shipments" title="محموله‌ها">
      {page.items.length === 0 ? (
        <EmptyState
          title="محموله‌ای نیست"
          description="محموله‌ای از انبارهای این سازمان نرفته و به آن هم فرستاده نشده است. محموله را از بخش انبار موردنظر بسازید."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {page.items.map((shipment) => (
            <li
              key={shipment.id}
              className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg border border-border bg-surface-raised p-4"
            >
              <div>
                <Link
                  href={`/inventory/shipments/${encodeURIComponent(shipment.id)}`}
                  className="font-medium underline"
                >
                  <Identifier>{shipment.id}</Identifier>
                </Link>
                <p className="mt-1 text-sm text-content-muted">
                  از انبار <Identifier>{shipment.originWarehouseId}</Identifier> به سازمان{' '}
                  <Identifier>{shipment.consigneeOrganizationId}</Identifier> · ایجاد در{' '}
                  {formatJalaliDateLong(shipment.createdAt)}
                </p>
              </div>
              <StatusBadge status={shipment.status} label={shipmentStatusLabel(shipment.status)} />
            </li>
          ))}
        </ul>
      )}
      {page.nextCursor ? (
        <div className="mt-4">
          <ButtonLink
            href={inventoryHref(query, { shipmentCursor: page.nextCursor })}
            tone="secondary"
          >
            محموله‌های بعدی
          </ButtonLink>
        </div>
      ) : null}
    </Section>
  );
}

function StockBody({
  stock,
  query,
}: {
  stock: ReadResult<StockPage> | null;
  query: InventoryQuery;
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
