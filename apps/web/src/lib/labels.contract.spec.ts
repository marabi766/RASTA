import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ASSET_STATUSES,
  ASSET_TYPES,
  INSPECTION_RESULTS,
  TIMELINE_CATEGORIES,
} from './asset-fields';
import {
  assetStatusLabel,
  assetStatusOptions,
  assetTypeLabel,
  assetTypeOptions,
  blockerLabel,
  inspectionResultLabel,
  timelineCategoryLabel,
  timelineCategoryOptions,
} from './labels';

/**
 * The portal's asset vocabulary, pinned to asset-service's source (L5-02).
 *
 * Read as text rather than imported, like `design-tokens.spec.ts` reads the
 * stylesheet: A-02 forbids importing `services/*\/src`, and the service's DTO
 * module pulls in packages the portal does not depend on. What is under test
 * is a property of that source file — the literal lists in it — so reading
 * the file is the direct way to check it.
 *
 * Both directions matter. A value the service has and the portal lacks renders
 * untranslated; a value the portal offers and the service lacks is worse — the
 * filter sends it, the service refuses it, and the page becomes an error.
 */

const ASSET_SERVICE = join(__dirname, '..', '..', '..', '..', 'services', 'asset-service', 'src');
const DTO = readFileSync(join(ASSET_SERVICE, 'asset', 'dto.ts'), 'utf8');
const SERVICE = readFileSync(join(ASSET_SERVICE, 'asset', 'asset.service.ts'), 'utf8');

/** The single-quoted strings inside `[ … ]`, in order. */
function literals(list: string): string[] {
  return [...list.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

/** `export const NAME = [ … ] as const` out of the DTO module. */
function namedList(name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const`).exec(DTO);
  if (!match) throw new Error(`asset-service's dto.ts no longer declares ${name} as a list`);
  return literals(match[1]!);
}

/** The inline `field: z.enum([ … ])` inside one schema of the DTO module. */
function inlineEnum(schema: string, field: string): string[] {
  const start = DTO.indexOf(`export const ${schema} =`);
  if (start < 0) throw new Error(`asset-service's dto.ts no longer declares ${schema}`);
  const match = new RegExp(`${field}: z\\.enum\\(\\[([^\\]]*)\\]\\)`).exec(DTO.slice(start));
  if (!match) throw new Error(`${schema}.${field} is no longer an inline z.enum`);
  return literals(match[1]!);
}

describe('the asset vocabulary matches asset-service', () => {
  it.each([
    ['ASSET_TYPES', ASSET_TYPES],
    ['OPERATIONAL_STATUSES', ASSET_STATUSES],
    ['TIMELINE_CATEGORIES', TIMELINE_CATEGORIES],
  ] as const)('%s, value for value and in order', (name, portal) => {
    expect([...portal]).toEqual(namedList(name));
  });

  it('the inspection result', () => {
    expect([...INSPECTION_RESULTS]).toEqual(inlineEnum('createInspectionSchema', 'result'));
  });

  it('offers exactly the service’s values as filters — nothing it would refuse', () => {
    expect(assetTypeOptions.map((o) => o.value)).toEqual(namedList('ASSET_TYPES'));
    expect(assetStatusOptions.map((o) => o.value)).toEqual(namedList('OPERATIONAL_STATUSES'));
    expect(timelineCategoryOptions.map((o) => o.value)).toEqual(namedList('TIMELINE_CATEGORIES'));
  });

  // The fallback returns the raw value, so "translated" means "came back
  // different" — and Persian, not the same Latin code under another spelling.
  it.each([
    ['type', ASSET_TYPES, assetTypeLabel],
    ['status', ASSET_STATUSES, assetStatusLabel],
    ['timeline category', TIMELINE_CATEGORIES, timelineCategoryLabel],
    ['inspection result', INSPECTION_RESULTS, inspectionResultLabel],
  ] as const)('gives every asset %s a Persian label', (_, values, label) => {
    for (const value of values) {
      expect(label(value)).not.toBe(value);
      expect(label(value)).toMatch(/^[؀-ۿ‌ ]+$/);
    }
  });
});

describe('compliance blockers match what asset-service sends', () => {
  /** Every argument of `blockers.push(…)` in the service, as source text. */
  const pushed = [...SERVICE.matchAll(/blockers\.push\(\s*(['`])(.*?)\1\s*\)/g)].map((m) => ({
    quote: m[1]!,
    text: m[2]!,
  }));

  it('finds the blockers in the service at all', () => {
    // Guards the regex above: a refactor that moved the sentences elsewhere
    // would otherwise leave every assertion below vacuously true.
    expect(pushed.length).toBeGreaterThanOrEqual(5);
  });

  it('translates every fixed sentence the service can send', () => {
    for (const { text } of pushed.filter((p) => p.quote === "'")) {
      expect(blockerLabel(text)).not.toBe(text);
      expect(blockerLabel(text)).toMatch(/[؀-ۿ]/);
    }
  });

  it('translates the status blocker, with the status in Persian too', () => {
    const templates = pushed.filter((p) => p.quote === '`').map((p) => p.text);
    expect(templates).toEqual(['Asset status is ${status}']);
    for (const status of ASSET_STATUSES) {
      const label = blockerLabel(`Asset status is ${status}`);
      expect(label).toContain(assetStatusLabel(status));
      expect(label).not.toMatch(/[A-Za-z]/);
    }
  });

  it('still shows a sentence it does not know, untranslated rather than dropped', () => {
    expect(blockerLabel('Something new')).toBe('Something new');
  });
});
