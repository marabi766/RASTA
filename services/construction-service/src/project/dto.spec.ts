import {
  MAX_AREA_POSITIONS,
  amountMinorInput,
  cancelProjectSchema,
  createNeedSchema,
  createProjectSchema,
  listProjectsQuerySchema,
  polygonInput,
  quantityInput,
  updateNeedSchema,
  updateProjectSchema,
  withdrawNeedSchema,
} from './dto';

/**
 * The boundary: what a client may send, and — as much — what it may not.
 */

const SQUARE = {
  type: 'Polygon',
  coordinates: [
    [
      [54.3, 31.8],
      [54.4, 31.8],
      [54.4, 31.9],
      [54.3, 31.9],
      [54.3, 31.8],
    ],
  ],
};

const PROJECT = {
  title: 'Village road resurfacing',
  operationType: 'road',
  scopeOfWork: 'Resurface 2 km of the main road',
  locationDescription: 'Main road, north entrance',
};

describe('createProject', () => {
  it('accepts the four required fields alone', () => {
    expect(createProjectSchema.safeParse(PROJECT).success).toBe(true);
  });

  it('accepts an area and an estimate', () => {
    expect(
      createProjectSchema.safeParse({ ...PROJECT, area: SQUARE, estimatedCostMinor: '0' }).success,
    ).toBe(true);
  });

  it.each(['organizationId', 'status', 'createdBy', 'version', 'id'])(
    'refuses %s in the body: it is decided by the token or the lifecycle',
    (field) => {
      expect(createProjectSchema.safeParse({ ...PROJECT, [field]: 'x' }).success).toBe(false);
    },
  );

  it('refuses blank text after trimming', () => {
    expect(createProjectSchema.safeParse({ ...PROJECT, title: '   ' }).success).toBe(false);
  });

  it('trims what it keeps', () => {
    const parsed = createProjectSchema.parse({ ...PROJECT, title: '  Road  ' });
    expect(parsed.title).toBe('Road');
  });
});

describe('amounts', () => {
  it.each(['0', '1', '9223372036854775807'])('accepts %s', (value) => {
    expect(amountMinorInput.safeParse(value).success).toBe(true);
  });

  it.each(['-1', '1.5', '01', '1e9', '', '9223372036854775808', '99999999999999999999'])(
    'refuses %s',
    (value) => {
      expect(amountMinorInput.safeParse(value).success).toBe(false);
    },
  );

  it('refuses a number: money travels as a string', () => {
    expect(createProjectSchema.safeParse({ ...PROJECT, estimatedCostMinor: 100 }).success).toBe(
      false,
    );
  });
});

describe('quantities', () => {
  it.each(['1', '0.5', '12.2500', '99999999999999.9999'])('accepts %s', (value) => {
    expect(quantityInput.safeParse(value).success).toBe(true);
  });

  it.each(['0', '0.0000', '-1', '1.23456', '.5', '1e3', 'abc', '01'])('refuses %s', (value) => {
    expect(quantityInput.safeParse(value).success).toBe(false);
  });
});

describe('the operating area', () => {
  it('accepts a closed ring in range', () => {
    expect(polygonInput.safeParse(SQUARE).success).toBe(true);
  });

  it('refuses an open ring', () => {
    const open = {
      type: 'Polygon',
      coordinates: [
        [
          [54.3, 31.8],
          [54.4, 31.8],
          [54.4, 31.9],
          [54.3, 31.95],
        ],
      ],
    };
    expect(polygonInput.safeParse(open).success).toBe(false);
  });

  it('refuses a position out of range, including swapped latitude and longitude', () => {
    const outOfRange = {
      type: 'Polygon',
      coordinates: [
        [
          [0, 91],
          [1, 0],
          [1, 1],
          [0, 91],
        ],
      ],
    };
    expect(polygonInput.safeParse(outOfRange).success).toBe(false);
  });

  it('refuses a ring with fewer than four positions', () => {
    expect(
      polygonInput.safeParse({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [0, 0],
          ],
        ],
      }).success,
    ).toBe(false);
  });

  it('refuses a three-dimensional position', () => {
    expect(
      polygonInput.safeParse({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0, 5],
            [1, 0, 5],
            [1, 1, 5],
            [0, 0, 5],
          ],
        ],
      }).success,
    ).toBe(false);
  });

  it('refuses another geometry type', () => {
    expect(polygonInput.safeParse({ ...SQUARE, type: 'MultiPolygon' }).success).toBe(false);
  });

  it('refuses more positions in total than the cap', () => {
    const ring = Array.from({ length: 999 }, (_, i) => [i / 1000, 0]);
    ring.push([0, 0]);
    const coordinates = Array.from({ length: 6 }, () => ring);
    expect(coordinates.length * ring.length).toBeGreaterThan(MAX_AREA_POSITIONS);
    const result = polygonInput.safeParse({ type: 'Polygon', coordinates });
    expect(result.success).toBe(false);
  });
});

describe('updates', () => {
  it('requires expectedVersion and at least one field', () => {
    expect(updateProjectSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ title: 'New' }).success).toBe(false);
    expect(updateProjectSchema.safeParse({ expectedVersion: 1, title: 'New' }).success).toBe(true);
  });

  it('lets null clear the optional fields, and only those', () => {
    expect(
      updateProjectSchema.safeParse({ expectedVersion: 1, area: null, estimatedCostMinor: null })
        .success,
    ).toBe(true);
    expect(updateProjectSchema.safeParse({ expectedVersion: 1, title: null }).success).toBe(false);
  });

  it('refuses a status change through PATCH', () => {
    expect(updateProjectSchema.safeParse({ expectedVersion: 1, status: 'APPROVED' }).success).toBe(
      false,
    );
  });

  it('applies the same rules to a need', () => {
    expect(updateNeedSchema.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(updateNeedSchema.safeParse({ expectedVersion: 1, quantity: null }).success).toBe(true);
    expect(updateNeedSchema.safeParse({ expectedVersion: 0, unit: 'm' }).success).toBe(false);
  });
});

describe('reasons', () => {
  it('require eight characters after trimming, for a cancellation and a withdrawal', () => {
    expect(cancelProjectSchema.safeParse({ expectedVersion: 1, reason: '  short ' }).success).toBe(
      false,
    );
    expect(
      withdrawNeedSchema.safeParse({ expectedVersion: 1, reason: 'Funding withdrawn' }).success,
    ).toBe(true);
  });
});

describe('needs and queries', () => {
  it('accepts a need with only a title and description', () => {
    expect(createNeedSchema.safeParse({ title: 'Asphalt', description: 'Hot mix' }).success).toBe(
      true,
    );
  });

  it('refuses a need that tries to set its own status', () => {
    expect(
      createNeedSchema.safeParse({ title: 'Asphalt', description: 'Hot mix', status: 'SUBMITTED' })
        .success,
    ).toBe(false);
  });

  it('refuses an unknown status filter and an unknown query parameter', () => {
    expect(listProjectsQuerySchema.safeParse({ status: 'ARCHIVED' }).success).toBe(false);
    expect(listProjectsQuerySchema.safeParse({ organizationId: 'ORG-B' }).success).toBe(false);
  });

  it('bounds the page size', () => {
    expect(listProjectsQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
    expect(listProjectsQuerySchema.parse({}).limit).toBe(25);
  });
});
