import { resolve } from 'node:path';
import { findKeyReaders } from '@rasta/testing';

/**
 * Every read, compare and search of an external code goes through its key (FU-084 r2, #723 r1 F1):
 * `ux_organization_external_code_key` compares `organization_text_key`, so a reader that compares
 * the bytes misses `IR-12` typed as `IR-۱۲`. A reader not listed here fails until it is reviewed and
 * listed with what makes it compare by the key.
 */
const READERS: Record<string, readonly string[]> = {
  'src/organization/organization.repository.ts#OrganizationRepository.findByExternalCode#sql': [
    'organization_text_key(external_code) = organization_text_key(${externalCode}::text)',
  ],
  'src/organization/organization.repository.ts#OrganizationRepository.list#sql': [
    'uniqueTextSearchKey(query.q, { caseFold: true })',
    "strpos(translate(organization_text_key(o.external_code),\n                                      'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'),\n                            ${codeKey}::text) > 0",
  ],
};

describe('every reader of an external code compares its key (FU-084 r2)', () => {
  const sites = findKeyReaders({
    root: resolve(__dirname, '../..'),
    fields: ['externalCode'],
    columns: ['external_code'],
  });

  it('finds exactly the reviewed readers', () => {
    expect(sites.map((site) => `${site.file}#${site.reader}#${site.kind}`)).toEqual(
      Object.keys(READERS).sort(),
    );
  });

  it.each(Object.entries(READERS))('%s compares by the key', (key, fragments) => {
    const site = sites.find(
      (candidate) => `${candidate.file}#${candidate.reader}#${candidate.kind}` === key,
    );
    for (const fragment of fragments) expect(site?.body).toContain(fragment);
  });

  it('no other reader names the column bare', () => {
    const list = sites.find((site) => site.reader === 'OrganizationRepository.list')!;
    expect(list.body).not.toMatch(/lower\(coalesce\(o\.external_code/);
  });
});
