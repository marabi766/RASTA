import { RastaError, zodPipe } from '@rasta/nest-common';
import { polygonInput } from './dto';

/**
 * Golden fixture for the zod 4 migration (GHSA-mrhx-c7xc-m3w5, PR B): the
 * operating area's exact-length positions, `z.array(...).length(2)` inside
 * bounded rings, as the shared pipe reports them.
 *
 * The snapshot beside this file was recorded under **zod 3.25.76** and is the
 * oracle B is measured against. Never re-record it (`-u`) to make a migration
 * pass: a difference is a behaviour change, fixed in the code. It pins parsing
 * only; geometric validity is PostGIS's (`ck_project_area_valid`).
 */

type Outcome = { parsed: unknown } | { refused: string; details: unknown };

function outcome(input: unknown): Outcome {
  try {
    return { parsed: zodPipe(polygonInput).transform(input, { type: 'body' }) };
  } catch (error) {
    if (error instanceof RastaError) return { refused: error.code, details: error.details };
    throw error;
  }
}

const square = [
  [51.3, 35.6],
  [51.4, 35.6],
  [51.4, 35.7],
  [51.3, 35.6],
];

const area = (coordinates: unknown) => outcome({ type: 'Polygon', coordinates });

describe('zod-3 golden: the operating area’s positions', () => {
  it('exact-length positions, ring bounds and the closing rule', () => {
    expect({
      closedSquare: area([square]),
      withHole: area([square, square]),
      positionOfOne: area([[[51.3], ...square.slice(1)]]),
      positionOfThree: area([[[51.3, 35.6, 1200], ...square.slice(1)]]),
      emptyPosition: area([[[], ...square.slice(1)]]),
      positionAsText: area([[['51.3', '35.6'], ...square.slice(1)]]),
      nonFinite: area([[[Number.POSITIVE_INFINITY, 35.6], ...square.slice(1)]]),
      latitudePastNinety: area([[[51.3, 90.5], ...square.slice(1, 3), [51.3, 90.5]]]),
      notClosed: area([[...square.slice(0, 3), [51.35, 35.65]]]),
      threePositions: area([square.slice(0, 3)]),
      noRings: area([]),
      twentyOneRings: area(Array.from({ length: 21 }, () => square)),
      notAPolygon: outcome({ type: 'Point', coordinates: [51.3, 35.6] }),
      extraKey: outcome({ type: 'Polygon', coordinates: [square], crs: 'EPSG:4326' }),
    }).toMatchSnapshot();
  });
});
