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
}

export interface RequestedLine {
  readonly offerId: string;
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
}

/**
 * Prices a set of requested lines against the offers as they are right now.
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

  for (const line of requested) {
    if (seen.has(line.offerId)) {
      // Merging them would change the quantity the buyer sees confirmed, and
      // silently passing both would violate the unique index anyway.
      throw RastaError.businessRule('An offer may appear on an order only once', {
        offerId: line.offerId,
      });
    }
    seen.add(line.offerId);

    const offer = offers.get(line.offerId);
    if (!offer) {
      // 404 rather than 422: an offer that is not published is, to this
      // buyer, an offer that does not exist.
      throw RastaError.notFound('Offer', line.offerId);
    }

    if (offer.status !== 'PUBLISHED') {
      throw RastaError.notFound('Offer', line.offerId);
    }

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

    const lineTotal = offer.unitPriceMinor * BigInt(line.quantity);
    total += lineTotal;

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
  };
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
