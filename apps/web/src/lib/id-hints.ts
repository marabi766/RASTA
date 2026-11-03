/**
 * The hint under a field that takes an id typed or pasted by a person.
 *
 * **No example id, on purpose.** The forms used to say «مانند AST_01J…», but the
 * platform's ids come in more than one shape: ids the services generate use an
 * underscore (`AST_01J…`) and the seeded demo machines use hyphens
 * (`AST-SEED-0001`, `ORG-DEH-0001`). Either form is valid, so an example of one
 * reads as a correction of the other (demo run 2026-10-24, defect 11). The hint
 * says where to take the id from; the service decides whether it is right.
 */
export const ASSET_ID_HINT = 'شناسهٔ ماشین را همان‌طور که در فهرست ماشین‌آلات آمده وارد کنید';

export const ORGANIZATION_ID_HINT = 'شناسهٔ سازمان را همان‌طور که به شما داده‌اند وارد کنید';
