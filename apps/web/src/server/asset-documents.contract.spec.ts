/**
 * @jest-environment node
 */
import ts from 'typescript';

import { DOCUMENT_KINDS } from '@/lib/asset-document-fields';
import { assetDocumentSchema } from '@/server/assets';
import {
  collect,
  decoratorOf,
  handlerOf,
  literalsOf,
  parseSource,
  readSource,
  rolesOf,
  schemaProperties,
  squash,
  topLevelConst,
} from '@/test/service-source';

import {
  ATTACH_MAPPING,
  DOCUMENT_BOUNDS,
  DOCUMENT_CLASS_BY_KIND,
  DOCUMENT_SERVICE_MAPPING,
  DOCUMENT_SERVICE_MESSAGES,
  attachDocumentFormSchema,
  canAttachAssetDocuments,
  parseAttachDocumentForm,
} from './asset-documents';
import { RECORD_KEY_REUSED_MESSAGE } from './asset-records';

/**
 * What the attach-document chain depends on, pinned to the services' source —
 * the technique of `asset-records.contract.spec.ts`: A-02 forbids importing
 * `services/*\/src`, so the portal keeps copies and this test fails the moment a
 * copy and its original disagree. Three services are read: asset-service (the
 * reference), document-service (the file) and, for the sentences it says, its
 * policy and lifecycle. The reader refuses anything it cannot read literally.
 */

const assetDto = parseSource(readSource('services', 'asset-service', 'src', 'asset', 'dto.ts'));
const assetController = parseSource(
  readSource('services', 'asset-service', 'src', 'asset', 'asset.controller.ts'),
);
const assetServiceSource = readSource(
  'services',
  'asset-service',
  'src',
  'asset',
  'asset.service.ts',
);
const documentController = parseSource(
  readSource('services', 'document-service', 'src', 'document', 'document.controller.ts'),
);
const documentDto = parseSource(
  readSource('services', 'document-service', 'src', 'document', 'dto.ts'),
);
const policySource = readSource('services', 'document-service', 'src', 'content', 'policy.ts');
const policy = parseSource(policySource);
const lifecycleSource = readSource(
  'services',
  'document-service',
  'src',
  'document',
  'document.service.ts',
);

const EVERY_ROLE = [
  'SYSTEM_ADMIN',
  'UNION_ADMIN',
  'ORGANIZATION_ADMIN',
  'FLEET_MANAGER',
  'PROCUREMENT_USER',
  'OPERATOR',
  'DRIVER',
  'AUDITOR',
  'CONTRACTOR',
  'SUPPLIER',
  'TECHNICIAN',
];

describe('who may attach', () => {
  it('is the same set of roles for the reference as the portal offers the form to', () => {
    const admitted = rolesOf(assetController, 'attachDocument');
    expect(admitted.length).toBeGreaterThan(0);
    const offered = EVERY_ROLE.filter((role) => canAttachAssetDocuments([role]));
    expect(offered.sort()).toEqual(EVERY_ROLE.filter((role) => admitted.includes(role)).sort());
  });

  it('is a subset of the roles document-service lets upload and register a file', () => {
    // A role offered the form that document-service refuses would be shown a
    // form that can never succeed.
    const offered = EVERY_ROLE.filter((role) => canAttachAssetDocuments([role]));
    for (const method of ['requestUploadUrl', 'finalize']) {
      const admitted = rolesOf(documentController, method);
      for (const role of offered) expect(admitted).toContain(role);
    }
  });

  it('still serves the reference, the upload URL and the registration at the paths the portal posts to', () => {
    expect(
      decoratorOf(assetController, 'attachDocument', 'Post')?.arguments.map((a) => a.getText()),
    ).toEqual(["':id/documents'"]);
    expect(
      decoratorOf(documentController, 'requestUploadUrl', 'Post')?.arguments.map((a) =>
        a.getText(),
      ),
    ).toEqual(["'upload-url'"]);
    // `@Post()` on the controller `documents`, version 1: `/v1/documents`.
    expect(decoratorOf(documentController, 'finalize', 'Post')?.arguments).toHaveLength(0);
    expect(
      squash(
        readSource('services', 'document-service', 'src', 'document', 'document.controller.ts'),
      ),
    ).toContain("@Controller({path:'documents',version:'1'})");
  });
});

describe('the replay key', () => {
  it('attach reads the Idempotency-Key header, requires it, and runs under the idempotency store', () => {
    const text = squash(handlerOf(assetController, 'attachDocument').getText()) ?? '';
    expect(text).toContain("@Headers('idempotency-key')");
    expect(text).toContain('requiredIdempotencyKey(idempotencyKey)');
    expect(text).toContain('this.idempotency.execute');
    // The asset is part of what the key is bound to; the stored answer is a 201.
    expect(text).toContain('{assetId:id,...dto}');
    expect(text).toContain(',201,');
    expect(
      decoratorOf(assetController, 'attachDocument', 'ApiHeader')?.arguments[0]?.getText(),
    ).toBe('IDEMPOTENCY_KEY_HEADER');
  });
});

describe('the reference body', () => {
  it('is strict, and takes the fields the form sends plus the document id the upload produced', () => {
    expect(squash(topLevelConst(assetDto, 'attachDocumentSchema').getText())).toMatch(
      /\.strict\(\)$/,
    );
    const properties = schemaProperties(assetDto, 'attachDocumentSchema');
    expect([...properties.keys()].sort()).toEqual(
      ['documentId', 'kind', 'title', 'issuedAt', 'expiresAt'].sort(),
    );
    // What the portal may leave out is exactly what the service lets it leave out.
    const optional = [...properties].filter(([, text]) => /\.optional\(\)$/.test(text));
    expect(optional.map(([key]) => key).sort()).toEqual(['issuedAt', 'expiresAt'].sort());
  });

  it('takes the kinds the form offers, and no others', () => {
    expect(literalsOf(topLevelConst(assetDto, 'DOCUMENT_KINDS').getText())).toEqual([
      ...DOCUMENT_KINDS,
    ]);
    expect(squash(schemaProperties(assetDto, 'attachDocumentSchema').get('kind'))).toBe(
      'z.enum(DOCUMENT_KINDS)',
    );
  });

  it('bounds the title as the form does, as display text', () => {
    expect(squash(schemaProperties(assetDto, 'attachDocumentSchema').get('title'))).toBe(
      `displayText(${DOCUMENT_BOUNDS.title.min},${DOCUMENT_BOUNDS.title.max})`,
    );
  });

  it('takes the dates as ISO datetimes, optional, with no ordering rule the form could be missing', () => {
    const properties = schemaProperties(assetDto, 'attachDocumentSchema');
    expect(squash(properties.get('issuedAt'))).toBe('z.string().datetime().optional()');
    expect(squash(properties.get('expiresAt'))).toBe('z.string().datetime().optional()');
    expect(squash(topLevelConst(assetDto, 'attachDocumentSchema').getText())).not.toContain(
      '.refine(',
    );
  });

  it('sends a body that satisfies what it pins, for every field the form holds', () => {
    const parsed = parseAttachDocumentForm({
      kind: 'MANUAL',
      title: 'دفترچهٔ راهنما',
      issuedAt: '2026-10-01',
      expiresAt: '2027-10-01',
    });
    expect(parsed.ok && Object.keys(parsed.body).sort()).toEqual(
      [...schemaProperties(assetDto, 'attachDocumentSchema').keys()]
        .filter((key) => key !== 'documentId')
        .sort(),
    );
  });

  it('places every service field on the form field that carries it', () => {
    const serviceFields = [...schemaProperties(assetDto, 'attachDocumentSchema').keys()].filter(
      (key) => key !== 'documentId',
    );
    expect(Object.keys(ATTACH_MAPPING.paths).sort()).toEqual(serviceFields.sort());
  });

  it('still refuses a title the service would, for the characters it names', () => {
    for (const bad of ['س', '<b>x</b>', `سند${String.fromCodePoint(0x202e)}ی`]) {
      expect(
        attachDocumentFormSchema.safeParse({
          kind: 'OTHER',
          title: bad,
          issuedAt: '',
          expiresAt: '',
        }).success,
      ).toBe(false);
    }
  });
});

describe('the file in document-service', () => {
  const classes = literalsOf(topLevelConst(policy, 'DOCUMENT_CLASSES').getText());

  it('files every kind under a class document-service has', () => {
    expect(classes.length).toBeGreaterThan(0);
    for (const kind of DOCUMENT_KINDS) expect(classes).toContain(DOCUMENT_CLASS_BY_KIND[kind]);
  });

  it('declares exactly the fields the upload-URL request takes — and no limit of its own', () => {
    const properties = schemaProperties(documentDto, 'requestUploadUrlSchema');
    expect([...properties.keys()].sort()).toEqual(
      ['documentClass', 'contentType', 'sizeBytes', 'filename'].sort(),
    );
    expect(squash(topLevelConst(documentDto, 'requestUploadUrlSchema').getText())).toMatch(
      /\.strict\(\)$/,
    );
    // The portal's mapping places the declaration's own fields on the file.
    expect(Object.keys(DOCUMENT_SERVICE_MAPPING.paths).sort()).toEqual(
      [...properties.keys()].sort(),
    );
  });

  it('registers with an intent id and an owner reference of two fields, both or neither', () => {
    const properties = schemaProperties(documentDto, 'finalizeDocumentSchema');
    expect([...properties.keys()].sort()).toEqual(
      ['uploadIntentId', 'ownerResourceType', 'ownerResourceId'].sort(),
    );
    const text = squash(topLevelConst(documentDto, 'finalizeDocumentSchema').getText()) ?? '';
    expect(text).toContain(
      '(value.ownerResourceType===undefined)===(value.ownerResourceId===undefined)',
    );
    // What the portal sends as the owner type fits the service's bound.
    expect(squash(properties.get('ownerResourceType'))).toBe(
      'plainText().min(1).max(64).optional()',
    );
    expect('Asset'.length).toBeLessThanOrEqual(64);
  });

  it('says every sentence the portal words, in the place the portal says it was found', () => {
    for (const sentence of Object.keys(DOCUMENT_SERVICE_MESSAGES)) {
      const literal = collect(
        parseSource(`${policySource}\n${lifecycleSource}`),
        ts.isStringLiteralLike,
      ).some((node) => node.text === sentence);
      expect([sentence, literal]).toEqual([sentence, true]);
    }
  });
});

describe('the dossier lists the reference as the portal reads it', () => {
  it('lists exactly the fields the portal keeps', () => {
    const start = assetServiceSource.indexOf('documents: documents.map(');
    expect(start).toBeGreaterThan(-1);
    const block = assetServiceSource.slice(start, assetServiceSource.indexOf('})),', start));
    const keys = [...block.matchAll(/^\s+(\w+):/gm)].map((match) => match[1]);
    expect(keys.sort()).toEqual(Object.keys(assetDocumentSchema.shape).sort());
  });
});

describe('the reused-key sentence', () => {
  it('is the records’ sentence: the attach step says a reused key in the very same words', () => {
    expect(RECORD_KEY_REUSED_MESSAGE).toBe(Object.values(ATTACH_MAPPING.messages ?? {})[0]);
  });
});
