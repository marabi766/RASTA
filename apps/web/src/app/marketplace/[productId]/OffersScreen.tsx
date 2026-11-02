import {
  Button,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  PageHeader,
  Section,
} from '@/ui';
import { DemoModeNotice, MoneyActionWithheld } from '@/app/DemoModeNotice';
import { MONEY_EFFECTS, mayOffer, type DemoMode } from '@/lib/demo-mode';
import { productKindLabel } from '@/lib/labels';
import { qualificationStateLabel } from '@/lib/supplier-fields';
import { formatMoney, toPersianDigits } from '@/lib/format';
import type { OffersPage, Product, ReadResult } from '@/server/marketplace';

import { PlaceOrderForm } from './PlaceOrderForm';
import type { Binding } from '@/lib/unresolved-tenancy';
import { ContextField } from '@/app/ContextField';

/**
 * `/marketplace/[productId]` — مقایسه پیشنهادها (docs/16 § ۱۶٫۶, role
 * `PROCUREMENT_USER`).
 *
 * The product read and the offers read are independent — a product with no
 * current offer is still a product worth naming, so this screen can say "no
 * supplier offers this right now" instead of a bare 404 for a link that used
 * to work.
 *
 * `supplierQualification` is rendered exactly as `marketplace-service` sends
 * it: always `'UNAVAILABLE'` today, because supplier-service does not exist
 * to check it. A checkmark here would claim a verification nobody performed
 * (`docs/16 § ۱۶٫۱۱`, ADR-041).
 */

/**
 * The marketplace's existing wording for an approved supplier, kept as it was
 * on main: the supplier screens spell the shared label without a hamza (PR 366
 * r5/r6), and which spelling the product uses is still an open owner question,
 * so this screen does not follow that change.
 */
const APPROVED_OFFER_LABEL = 'تأییدشده';

export interface OffersScreenProps {
  /** The organization tag this page's URLs carry (`server/page-context.ts`). */
  readonly context: string;
  readonly product: ReadResult<Product>;
  readonly offers: ReadResult<OffersPage>;
  readonly productId: string;
  readonly sort?: string;
  /** What the provider says (`fetchDemoMode`, Q-14): «حالت نمایشی», nothing, or that it is unknown. */
  readonly demoMode: DemoMode;
  /**
   * What placing an order needs from the page: the signed-in session's CSRF
   * token, a minter for the form's submission id (bound to that session, which
   * only the page has), and the caller's own organization, whose offers are
   * left out of the choice. Absent, the screen only compares.
   */
  readonly ordering?: {
    readonly csrfToken: string;
    readonly mintSubmissionId: () => string;
    readonly organizationId: string | null;
    /** One-way tags of this login, so a form can recognise its own remembered order (`submissionBinding`). */
    readonly binding: Binding;
    /** The session's lifetime: a remembered unresolved order is not kept longer than that. */
    readonly sessionMaxAgeSeconds: number;
  };
}

const CONTROL =
  'rounded-md border border-border-strong bg-surface-base px-3 py-2 text-sm text-content ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus';

function SortControl({
  productId,
  sort,
  context,
}: {
  productId: string;
  sort?: string;
  context: string;
}) {
  return (
    <form
      method="get"
      action={`/marketplace/${encodeURIComponent(productId)}`}
      className="flex flex-wrap items-end gap-4"
      aria-label="ترتیب پیشنهادها"
    >
      <ContextField context={context} />
      <label htmlFor="filter-sort" className="flex flex-col gap-1 text-sm text-content-muted">
        ترتیب
        <select id="filter-sort" name="sort" defaultValue={sort ?? ''} className={CONTROL}>
          <option value="PRICE_ASC">ارزان‌ترین ابتدا</option>
          <option value="PRICE_DESC">گران‌ترین ابتدا</option>
          <option value="LEAD_TIME_ASC">کوتاه‌ترین زمان تحویل</option>
        </select>
      </label>

      <Button type="submit">اعمال</Button>
    </form>
  );
}

function OfferRows({ offers }: { offers: OffersPage }) {
  if (offers.items.length === 0) {
    return (
      <EmptyState
        title="هیچ پیشنهادی منتشر نشده"
        description="اکنون هیچ تأمین‌کننده‌ای این کالا یا خدمت را عرضه نمی‌کند."
      />
    );
  }

  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">فهرست پیشنهادهای تأمین‌کنندگان</caption>
      <thead>
        <tr className="border-b border-border text-start text-content-muted">
          <th scope="col" className="p-3 text-start font-medium">
            تأمین‌کننده
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            قیمت واحد
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            موجودی
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            حداقل سفارش
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            زمان تحویل
          </th>
          <th scope="col" className="p-3 text-start font-medium">
            احراز صلاحیت
          </th>
        </tr>
      </thead>
      <tbody>
        {offers.items.map((offer) => (
          <tr key={offer.id} className="border-b border-border">
            <td className="p-3">
              <Identifier>{offer.supplierOrganizationId}</Identifier>
            </td>
            <td className="p-3">{formatMoney(offer.unitPriceMinor)}</td>
            <td className="p-3 text-content-muted">
              {toPersianDigits(String(offer.availableQuantity))}
            </td>
            <td className="p-3 text-content-muted">
              {toPersianDigits(String(offer.minimumQuantity))}
            </td>
            <td className="p-3 text-content-muted">
              {toPersianDigits(String(offer.leadTimeDays))} روز
            </td>
            <td className="p-3 text-content-muted">
              {offer.supplierQualification === 'UNAVAILABLE'
                ? 'هنوز فعال نیست'
                : offer.supplierQualification === 'APPROVED'
                  ? APPROVED_OFFER_LABEL
                  : qualificationStateLabel(offer.supplierQualification)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OrderSection({
  offers,
  ordering,
  productId,
  demoMode,
}: {
  offers: OffersPage;
  ordering: NonNullable<OffersScreenProps['ordering']>;
  productId: string;
  demoMode: DemoMode;
}) {
  // A plain link back to this page: a full navigation, so a new submission id is minted.
  const newOrderHref = `/marketplace/${encodeURIComponent(productId)}`;
  // An organization cannot order from itself; the service refuses it, and
  // offering the choice only to refuse it would be a form built to fail.
  const orderable = offers.items.filter(
    (offer) => offer.supplierOrganizationId !== ordering.organizationId,
  );

  return (
    <Section headingId="place-order" title="سفارش از یکی از پیشنهادها">
      {/* Placing an order holds its amount in escrow: not offered while the provider is unknown (Q-14). */}
      {!mayOffer(demoMode, MONEY_EFFECTS.placeOrder) ? (
        <MoneyActionWithheld title="ثبت سفارش اکنون در دسترس نیست" />
      ) : orderable.length === 0 ? (
        <EmptyState
          title="پیشنهادی برای سفارش نیست"
          description="هیچ پیشنهاد منتشرشده‌ای از سازمانی غیر از سازمان شما برای این کالا یا خدمت نیست."
        />
      ) : (
        <PlaceOrderForm
          offers={orderable}
          csrfToken={ordering.csrfToken}
          submissionId={ordering.mintSubmissionId()}
          newOrderHref={newOrderHref}
          productId={productId}
          binding={ordering.binding}
          sessionMaxAgeSeconds={ordering.sessionMaxAgeSeconds}
        />
      )}
    </Section>
  );
}

export function OffersScreen({
  context,
  product,
  offers,
  productId,
  sort,
  ordering,
  demoMode,
}: OffersScreenProps) {
  const title =
    product.kind === 'OK'
      ? product.data.name
      : product.kind === 'NOT_FOUND'
        ? 'کالا یا خدمت یافت نشد'
        : 'مقایسهٔ پیشنهادها';

  return (
    <>
      <PageHeader
        title={title}
        description={
          product.kind === 'OK'
            ? `${productKindLabel(product.data.kind)} — ${product.data.category} — واحد: ${product.data.unit}`
            : undefined
        }
      />

      <DemoModeNotice mode={demoMode} />

      {product.kind === 'NOT_FOUND' ? (
        <EmptyState
          title="این کالا یا خدمت پیدا نشد"
          description="شناسه اشتباه است یا از کاتالوگ برداشته شده."
        />
      ) : null}

      {product.kind === 'FORBIDDEN' ? <NoAccessState /> : null}

      {product.kind === 'UNAVAILABLE' ? (
        <ErrorState correlationId={product.correlationId} code={`UPSTREAM_${product.status}`} />
      ) : null}

      {product.kind === 'MALFORMED' ? (
        <ErrorState correlationId={product.correlationId} code="CONTRACT_MISMATCH" />
      ) : null}

      {product.kind === 'OK' ? (
        <Section headingId="offers" title="پیشنهادهای تأمین‌کنندگان">
          <SortControl productId={productId} sort={sort} context={context} />

          {offers.kind === 'FORBIDDEN' ? <NoAccessState /> : null}
          {offers.kind === 'UNAVAILABLE' ? (
            <ErrorState correlationId={offers.correlationId} code={`UPSTREAM_${offers.status}`} />
          ) : null}
          {offers.kind === 'MALFORMED' ? (
            <ErrorState correlationId={offers.correlationId} code="CONTRACT_MISMATCH" />
          ) : null}
          {offers.kind === 'NOT_FOUND' ? (
            <EmptyState title="پیشنهادی یافت نشد" description="این مسیر در بازار پاسخی نداشت." />
          ) : null}
          {offers.kind === 'OK' ? <OfferRows offers={offers.data} /> : null}
        </Section>
      ) : null}

      {product.kind === 'OK' && offers.kind === 'OK' && ordering ? (
        <OrderSection
          offers={offers.data}
          ordering={ordering}
          productId={productId}
          demoMode={demoMode}
        />
      ) : null}
    </>
  );
}
