/**
 * The shape of `/wallet`'s one form: the top-up's field name, and a blank set
 * of values.
 *
 * Separate from `server/wallet.ts`, which parses this and reaches the gateway
 * client, because that module pulls in `node:crypto` transitively and this
 * file is imported by a client component (`driver-fields.ts` documents why:
 * the build refuses a client component that imports Node's crypto).
 */

/**
 * `walletId` is not a field. The form always tops up *this organization's*
 * wallet, the one the page already read, so the id reaches the server action
 * bound (`action.bind(null, walletId)`) rather than as form content.
 */
export const TOP_UP_FIELDS = ['amountMinor'] as const;

export type TopUpFormField = (typeof TOP_UP_FIELDS)[number];
export type TopUpFormValues = Readonly<Record<TopUpFormField, string>>;

export const EMPTY_TOP_UP_FORM: TopUpFormValues = { amountMinor: '' };
