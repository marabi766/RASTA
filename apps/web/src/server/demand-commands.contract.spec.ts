/**
 * @jest-environment node
 */
import {
  DEMAND_REFUSAL_MESSAGES,
  DEMAND_STATUSES,
  MAX_NOTE_LENGTH,
  MAX_QUANTITY,
  PRODUCT_ID_PATTERN,
  demandFormSchema,
} from '@/lib/demand-commands';
import { loadWebServerEnv } from './env';
import { readSource, squash } from '@/test/service-source';

/**
 * What the demand screens copy from procurement-service, pinned to its source
 * (A-02 forbids importing `services/*\/src`): the statuses, the input limits,
 * the refusal reasons said in fixed words, the role default the portal mirrors,
 * the retention bounds the replay window mirrors, and the gateway route. Each
 * pin reads the declaration literally, so a change on either side fails here.
 */

const SERVICE = ['services', 'procurement-service', 'src'];
const dto = squash(readSource(...SERVICE, 'demand', 'dto.ts'))!;
const machine = squash(readSource(...SERVICE, 'demand', 'demand.state-machine.ts'))!;
const refusal = readSource(...SERVICE, 'shared', 'refusal.ts');
const env = squash(readSource(...SERVICE, 'config', 'env.ts'))!;
const controller = squash(readSource(...SERVICE, 'demand', 'demand.controller.ts'))!;
const store = squash(readSource(...SERVICE, 'shared', 'idempotency.ts'))!;
const routes = squash(readSource('services', 'api-gateway', 'src', 'config', 'routes.ts'))!;

describe('procurement-service’s demand contract', () => {
  it('the demand statuses are the service’s, in order', () => {
    expect(machine).toContain(
      `exportconstDEMAND_STATES=[${DEMAND_STATUSES.map((s) => `'${s}'`).join(',')}]asconst;`,
    );
  });

  it('the product id pattern, the quantity bound and the note limit', () => {
    expect(dto).toContain(`exportconstPRODUCT_ID_PATTERN=/${PRODUCT_ID_PATTERN.source}/;`);
    expect(dto).toContain('exportconstMAX_QUANTITY=2_147_483_647;');
    expect(MAX_QUANTITY).toBe(2_147_483_647);
    expect(dto).toContain(`exportconstMAX_NOTE_LENGTH=${MAX_NOTE_LENGTH};`);
    // The body the form builds is the service's strict schema, field for field.
    expect(dto).toContain('productId:z.string().regex(PRODUCT_ID_PATTERN)');
    expect(dto).toContain('quantity:z.number().int().min(1).max(MAX_QUANTITY)');
    expect(dto).toContain('note:plainText().min(1).max(MAX_NOTE_LENGTH).optional()');
  });

  it('every submission refusal reason has fixed words, and no other is claimed', () => {
    const area = refusal.slice(refusal.indexOf('submission: {'), refusal.indexOf('withdrawal: {'));
    const reasons = [...area.matchAll(/^\s+([A-Z_]+): 4\d\d,$/gm)].map((m) => m[1]);
    expect(reasons.sort()).toEqual(Object.keys(DEMAND_REFUSAL_MESSAGES).sort());
  });

  it('the portal’s role default mirrors PROCUREMENT_DEMAND_ROLES and refuses the roles it refuses', () => {
    expect(env).toContain(
      "PROCUREMENT_DEMAND_ROLES:z.string().prefault('PROCUREMENT_USER,ORGANIZATION_ADMIN')",
    );
    const base = {
      API_GATEWAY_URL: 'http://gateway.test:3000',
      OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
      OIDC_CLIENT_ID: 'rasta-web',
      WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
      WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
    };
    expect(loadWebServerEnv(base).WEB_PROCUREMENT_DEMAND_ROLES).toEqual([
      'PROCUREMENT_USER',
      'ORGANIZATION_ADMIN',
    ]);
    for (const role of ['AUDITOR', 'SYSTEM_ADMIN']) {
      expect(() => loadWebServerEnv({ ...base, WEB_PROCUREMENT_DEMAND_ROLES: role })).toThrow();
    }
    // The margin may never be less than the clock budget: the service has no replay fence.
    expect(() =>
      loadWebServerEnv({ ...base, WEB_PROCUREMENT_REPLAY_MARGIN_SECONDS: '299' }),
    ).toThrow();
    // The schema's floor; with a 1 h retention the shared window maximum (FU-156) asks for 330.
    expect(
      loadWebServerEnv({
        ...base,
        WEB_PROCUREMENT_IDEMPOTENCY_TTL_HOURS: '1',
        WEB_PROCUREMENT_REPLAY_MARGIN_SECONDS: '330',
      }).WEB_PROCUREMENT_REPLAY_MARGIN_SECONDS,
    ).toBe(330);
    expect(() =>
      loadWebServerEnv({ ...base, WEB_PROCUREMENT_REPLAY_MARGIN_SECONDS: '300' }),
    ).toThrow('WEB_PROCUREMENT_IDEMPOTENCY_TTL_HOURS');
  });

  it('the mirrored retention has the service’s bounds', () => {
    expect(env).toContain(
      'PROCUREMENT_IDEMPOTENCY_TTL_HOURS:z.coerce.number().int().min(1).max(168)',
    );
  });

  it('the endpoint takes a key and replays only for the same caller and body', () => {
    expect(controller).toContain("exportconstSUBMIT_DEMAND_ENDPOINT='POST/v1/demand-requests';");
    expect(controller).toContain('constkey=idempotentRequest(headers);');
    // FU-156: the key and the replay deadline are read together, by the store's one parser.
    expect(store).toContain("exportconstREPLAY_DEADLINE_HEADER='Idempotency-Replay-Deadline';");
    expect(store).toContain(
      'constreplayDeadlineMs=parseReplayDeadline(headers[REPLAY_DEADLINE_HEADER.toLowerCase()]);',
    );
    expect(routes).toContain("{prefix:'demand-requests',service:'procurement'}");
  });

  it('the form’s schema accepts exactly 500 code points of astral text and refuses 501', () => {
    const body = (note: string) =>
      demandFormSchema.safeParse({
        productId: 'PRD_01J00000000000000000000000',
        quantity: '1',
        note,
      });
    expect(body('😀'.repeat(MAX_NOTE_LENGTH)).success).toBe(true);
    expect(body('😀'.repeat(MAX_NOTE_LENGTH + 1)).success).toBe(false);
  });
});
