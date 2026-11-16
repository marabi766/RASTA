import { Prisma } from '../generated/prisma';
import { sourceFenceRefusal } from './source-fence-refusal';

const driver = (reason: string, code = 'P0001') =>
  `ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "${code}", message: "${reason}", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`;
const unknown = (message: string) =>
  new Prisma.PrismaClientUnknownRequestError(message, { clientVersion: 'test' });

describe('source fence statement classification', () => {
  it.each(['SOURCE_OWNER_DRIFT', 'SOURCE_INVENTORY_SEALED'])(
    'classifies %s without driver text',
    (reason) => {
      expect(sourceFenceRefusal(unknown(`payload-private\n${driver(reason)}`))).toMatchObject({
        name: 'UnprocessableEventError',
        reason,
        message: reason,
      });
    },
  );
  it.each([
    new Error(driver('SOURCE_OWNER_DRIFT')),
    unknown(driver('SOURCE_OWNER_DRIFT', '23514')),
    unknown(driver('SOURCE_OWNER_DRIFT_extra')),
    unknown(driver('SOURCE_FENCE_MISSING')),
    unknown(driver('SOURCE_OWNER_DRIFT') + '\nconnection lost'),
    unknown('SOURCE_OWNER_DRIFT'),
    new Prisma.PrismaClientKnownRequestError(driver('SOURCE_OWNER_DRIFT'), {
      code: 'P2028',
      clientVersion: 'test',
    }),
  ])('does not turn an unproven or unrelated failure into a definite refusal', (error) => {
    expect(sourceFenceRefusal(error)).toBeUndefined();
  });
});
