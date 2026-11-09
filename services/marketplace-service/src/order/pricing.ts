import { ERROR_CODES, MAX_AMOUNT_MINOR } from '@rasta/contracts';
import { RastaError } from '@rasta/nest-common';

/**
 * What an order costs, computed from server-side offers only.
 *
 * The single rule this file exists to keep: **the price comes from the `Offer`
 * row, never from the request.** `docs/17` § Marketplace states it as an
 * acceptance criterion, and it is the difference between a marketplace and a
 * form that lets a buyer name their own price.
 *
 * The request schema has no price field at all and is `.strict()`, so a client
 * that sends one is refused rather than silently overridden (ADR-037 § 5).
 * This module never sees a client-supplied number, which is the point:
 * it cannot use one by accident.
 *
 * The one thing a line does name is the offer **version** the buyer read
 * (D-156). It is not a price and never becomes one: it is compared with the
 * locked row's own version, and any difference refuses the order. So the price
 * charged is the row's, and the row is the one the buyer saw.
 */

/** The subset of an `Offer` row a price depends on. */
export interface PriceableOffer {
  readonly id: string;
  readonly organizationId: string;
  readonly productId: string;
  readonly unitPriceMinor: bigint;
  readonly currency: string;
  readonly availableQuantity: number;
  readonly minimumQuantity: number;
  readonly version: number;
  readonly status: string;
  /** The supplier's advertised lead time, in days (ADR-052 § 1-a). */
  readonly leadTimeDays: number;
}

export interface RequestedLine {
  readonly offerId: string;
  /** The `version` of the offer the buyer read; the order is refused at any other. */
  readonly offerVersion: number;
  readonly quantity: number;
}

export interface PricedLine {
  readonly offerId: string;
  readonly productId: string;
  readonly quantity: number;
  readonly unitPriceMinor: bigint;
  readonly lineTotalMinor: bigint;
  readonly currency: string;
  readonly offerVersion: number;
}

export interface PricedOrder {
  readonly supplierOrganizationId: string;
  readonly currency: string;
  readonly totalAmountMinor: bigint;
  readonly lines: readonly PricedLine[];
  /**
   * The slowest lead time among the priced lines, in days (ADR-052 § 1-a).
   *
   * The order's promise is the slowest one it makes: a supplier who commits
   * several parts with different lead times has committed to the last one
   * arriving, not to their average.
   */
  readonly maxLeadTimeDays: number;
}

/**
 * Prices a set of requested lines against the offers as they are right now —
 * which must be the versions the buyer read.
 *
 * Refuses, rather than adjusting, whenever the request and the catalogue
 * disagree. An order that silently comes back cheaper or smaller than asked
 * for is worse than one that fails: the buyer committed to something they did
 * not get, and found out after the money moved.
 */
export function priceOrder(
  requested: readonly RequestedLine[],
  offers: ReadonlyMap<string, PriceableOffer>,
): PricedOrder {
  if (requested.length === 0) {
    throw RastaError.businessRule('An order needs at least one line');
  }

  const seen = new Set<string>();
  const lines: PricedLine[] = [];
  let supplier: string | undefined;
  let currency: string | undefined;
  let total = 0n;
  let maxLeadTimeDays = 0;

  for (const [index, line] of requested.entries()) {
    if (seen.has(line.offerId)) {
      // Merging them would change the quantity the buyer sees confirmed, and
      // silently passing both would violate the unique index anyway.
      //
      // Until an offer is found, `line.offerId` is the client's text and is not
      // logged (S-09) — here, and in the two 404s below.
      throw RastaError.businessRule('An offer may appear on an order only once');
    }
    seen.add(line.offerId);

    const offer = offers.get(line.offerId);
    if (!offer) {
      // 404 rather than 422: an offer that is not published is, to this
      // buyer, an offer that does not exist.
      throw RastaError.notFound('Offer');
    }

    if (offer.status !== 'PUBLISHED') {
      throw RastaError.notFound('Offer');
    }

    // Only after the offer is known to be one this buyer may read: a stranger
    // to it has had its 404 above and learns nothing here. Strict equality, so
    // a version from the future is as stale as one from the past — neither is
    // the price on the row.
    if (offer.version !== line.offerVersion) throw offerVersionChanged(index);

    if (line.quantity < offer.minimumQuantity) {
      throw RastaError.businessRule(
        `Offer ${offer.id} has a minimum quantity of ${offer.minimumQuantity}`,
        { offerId: offer.id, requested: line.quantity, minimum: offer.minimumQuantity },
      );
    }

    if (line.quantity > offer.availableQuantity) {
      throw RastaError.businessRule(`Offer ${offer.id} has ${offer.availableQuantity} available`, {
        offerId: offer.id,
        requested: line.quantity,
        available: offer.availableQuantity,
      });
    }

    // One order, one supplier. Splitting across suppliers would mean one
    // financial obligation with two payees, and economic-service models a
    // transaction as having exactly one counterparty.
    supplier ??= offer.organizationId;
    if (supplier !== offer.organizationId) {
      throw RastaError.businessRule('An order may contain offers from only one supplier', {
        expected: supplier,
        found: offer.organizationId,
      });
    }

    // One order, one currency. A mixed-currency total is not a number.
    currency ??= offer.currency;
    if (currency !== offer.currency) {
      throw RastaError.businessRule('An order may contain only one currency', {
        expected: currency,
        found: offer.currency,
      });
    }

    // Each figure that is stored is bounded before it is stored: the line
    // total and the running order total both go into a BIGINT column, and a
    // price and a quantity that are each valid can multiply — or lines that
    // are each storable can add up — past it (marketplace audit F4). Checked
    // here, before anything is written, so the refusal is the caller's 422
    // and not the database's overflow surfacing as a 500.
    const lineTotal = offer.unitPriceMinor * BigInt(line.quantity);
    if (lineTotal > MAX_AMOUNT_MINOR) throw amountExceedsLimit(`lines[${index}].quantity`);
    total += lineTotal;
    if (total > MAX_AMOUNT_MINOR) throw amountExceedsLimit('lines');
    maxLeadTimeDays = Math.max(maxLeadTimeDays, offer.leadTimeDays);

    lines.push({
      offerId: offer.id,
      productId: offer.productId,
      quantity: line.quantity,
      unitPriceMinor: offer.unitPriceMinor,
      lineTotalMinor: lineTotal,
      currency: offer.currency,
      offerVersion: offer.version,
    });
  }

  if (total <= 0n) {
    // A zero-value order would create a zero-value obligation, and
    // economic-service refuses a journal with no amount. Better to say so here
    // than to have the saga fail on a hold nobody can explain.
    throw RastaError.businessRule('An order must have a positive total');
  }

  return {
    supplierOrganizationId: supplier as string,
    currency: currency as string,
    totalAmountMinor: total,
    lines,
    maxLeadTimeDays,
  };
}

/**
 * The closed reason (`details[].code`, docs/06 § 6.7) an order is refused for
 * when a line total or the order total would exceed {@link MAX_AMOUNT_MINOR},
 * the largest amount any service stores (a PostgreSQL `BIGINT`).
 */
export const ORDER_AMOUNT_EXCEEDS_LIMIT = 'ORDER_AMOUNT_EXCEEDS_LIMIT';

const ORDER_AMOUNT_EXCEEDS_LIMIT_MESSAGE =
  'The order total exceeds the largest amount the platform can record';

/**
 * Fixed words and the field the caller can change — never the offer's price
 * or the computed figure, which would turn the refusal into a calculator and
 * write amounts into the log (S-09).
 */
function amountExceedsLimit(path: string): RastaError {
  return new RastaError(ERROR_CODES.BUSINESS_RULE_VIOLATION, ORDER_AMOUNT_EXCEEDS_LIMIT_MESSAGE, {
    details: [
      { path, code: ORDER_AMOUNT_EXCEEDS_LIMIT, message: ORDER_AMOUNT_EXCEEDS_LIMIT_MESSAGE },
    ],
  });
}

/**
 * The closed reason (`details[].code`) an order is refused for when a line's
 * offer has been repriced since the buyer read it (D-156): the offer row locked
 * for pricing is at another version than the line names.
 */
export const OFFER_VERSION_CHANGED = 'OFFER_VERSION_CHANGED';

const OFFER_VERSION_CHANGED_MESSAGE =
  'The offer has changed since it was read; read it again before ordering';

/**
 * A conflict, not a business rule: the request was right when it was made, and
 * reading the offer again is how to make it right. Fixed words and the path —
 * neither the price nor the version the offer is at now (S-09), so a refusal
 * tells nobody what the supplier changed.
 */
function offerVersionChanged(index: number): RastaError {
  return new RastaError(ERROR_CODES.OPTIMISTIC_LOCK_FAILED, OFFER_VERSION_CHANGED_MESSAGE, {
    details: [
      {
        path: `lines[${index}].offerVersion`,
        code: OFFER_VERSION_CHANGED,
        message: OFFER_VERSION_CHANGED_MESSAGE,
      },
    ],
  });
}

/**
 * Recomputes the total from persisted lines.
 *
 * Used wherever the total is read back rather than trusted, for the reason
 * maintenance-service records on its own cost total: a stored sum that drifts
 * from the rows it summarises is a number nobody can audit.
 */
export function totalOf(lines: readonly { lineTotalMinor: bigint }[]): bigint {
  return lines.reduce((sum, line) => sum + line.lineTotalMinor, 0n);
}
