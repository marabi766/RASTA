import {
  Button,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  PageHeader,
  Section,
} from '@/ui';
import { productKindLabel } from '@/lib/labels';
import { formatMoney } from '@/lib/format';
import type { OffersPage, Product, ReadResult } from '@/server/marketplace';

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

export interface OffersScreenProps {
  readonly product: ReadResult<Product>;
  readonly offers: ReadResult<OffersPage>;
  readonly productId: string;
  readonly sort?: string;
}

const CONTROL =
  'rounded-md border border-border-strong bg-surface-base px-3 py-2 text-sm text-content ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus';

function SortControl({ productId, sort }: { productId: string; sort?: string }) {
  return (
    <form
      method="get"
      action={`/marketplace/${encodeURIComponent(productId)}`}
      className="flex flex-wrap items-end gap-4"
      aria-label="ترتیب پیشنهادها"
    >
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
            <td className="p-3 text-content-muted">{offer.availableQuantity}</td>
            <td className="p-3 text-content-muted">{offer.minimumQuantity}</td>
            <td className="p-3 text-content-muted">{offer.leadTimeDays} روز</td>
            <td className="p-3 text-content-muted">
              {offer.supplierQualification === 'UNAVAILABLE'
                ? 'هنوز فعال نیست'
                : offer.supplierQualification}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OffersScreen({ product, offers, productId, sort }: OffersScreenProps) {
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
          <SortControl productId={productId} sort={sort} />

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
    </>
  );
}
