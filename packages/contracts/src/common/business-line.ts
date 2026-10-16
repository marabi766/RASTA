import { z } from 'zod';

/**
 * The economic reason a commissionable transaction exists (ADR-045 § 1).
 *
 * Not the transaction type. The type says how the money moves — an escrowed
 * order, an approved obligation — and the business line says why the platform
 * may earn from it. A marketplace order can sell parts or broker a service;
 * reading the line off the type, or off a reference type, is the inference
 * ADR-045 rejects as implicit and brittle.
 *
 * A contract, not a list each service keeps: the service that owns the fact
 * sends one of these values, and economic-service (which owns commission,
 * ADR-045 § 4) prices it. Adding a line is a change here **and** a versioned
 * migration of economic-service's `BusinessLine` enum — a new line arrives
 * with no rule, and so earns nothing until one is approved.
 */
export const BUSINESS_LINES = [
  'PARTS',
  'INSURANCE',
  'MAINTENANCE',
  'LOGISTICS',
  'PROCUREMENT',
  'CONSTRUCTION',
  'MARKETPLACE_SERVICE',
] as const;

export type BusinessLine = (typeof BUSINESS_LINES)[number];

export const businessLineSchema = z.enum(BUSINESS_LINES);
