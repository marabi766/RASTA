import { VersioningType } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AssetController } from '../asset/asset.controller';
import { AssetService } from '../asset/asset.service';
import { InsuranceService } from '../insurance/insurance.service';

/**
 * The document this service actually serves.
 *
 * Asserted on the output of `SwaggerModule.createDocument` — the same call
 * `main.ts` makes — rather than on the decorator metadata that feeds it. The
 * defect being fixed here was a published contract that disagreed with the
 * runtime, and only the finished document can show that it no longer does.
 *
 * The providers are stubs because nothing is invoked: building the document
 * reads decorators, not behaviour, so this needs no database and no PostGIS.
 */
async function buildDocument() {
  const moduleRef = await Test.createTestingModule({
    controllers: [AssetController],
    providers: [
      { provide: AssetService, useValue: {} },
      { provide: InsuranceService, useValue: {} },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Rasta — Asset Service').setVersion('test').build(),
  );

  await app.close();
  return document;
}

describe('the served OpenAPI document', () => {
  let parameters: Record<string, Record<string, unknown>>;

  beforeAll(async () => {
    const document = await buildDocument();
    const operation = document.paths['/v1/assets/nearby']?.get;

    // The route has to be in the document before its parameters can be.
    expect(operation).toBeDefined();

    parameters = Object.fromEntries(
      ((operation?.parameters ?? []) as Record<string, unknown>[]).map((parameter) => [
        parameter.name as string,
        parameter,
      ]),
    );
  });

  it('publishes availableOnly as a boolean defaulting to false', () => {
    // The contract defect this closes: the parameter's runtime type is
    // `boolean | string`, because that is how a boolean crosses a query
    // string. Published as that union it would read `anyOf: [boolean, string]`
    // — arbitrary strings, to a generated client, when the parser accepts
    // eight spellings and rejects everything else with a 400.
    expect(parameters.availableOnly).toMatchObject({
      name: 'availableOnly',
      in: 'query',
      required: false,
      schema: { type: 'boolean', default: false },
    });
  });

  it('does not offer availableOnly as a string in any form', () => {
    const schema = parameters.availableOnly?.schema as Record<string, unknown>;

    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(JSON.stringify(schema)).not.toContain('string');
  });

  it('publishes the rest of the radius search too', () => {
    // The parameters were validated on every request and described nowhere:
    // before this the operation carried none at all.
    expect(parameters.latitude).toMatchObject({
      required: true,
      schema: { type: 'number', minimum: -90, maximum: 90 },
    });
    expect(parameters.radiusMeters).toMatchObject({
      required: false,
      schema: { type: 'integer', default: 50_000, maximum: 500_000 },
    });
    expect(parameters.limit).toMatchObject({
      required: false,
      schema: { type: 'integer', default: 25, maximum: 100 },
    });
    expect(parameters.type).toMatchObject({ required: false });
    expect((parameters.type?.schema as { type: string }).type).toBe('string');
  });
});
