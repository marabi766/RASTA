/**
 * @jest-environment node
 */
import { z } from 'zod';

import {
  mintContractStamp,
  verifyContractStamp,
  scopeOfTarget,
  type ContractTarget,
} from './contract-command-replay';
import { mintFlash, readFlash } from './flash';
import { signPayload, verifyPayload } from './signed-payload';
import type { WebSession } from './session';

/**
 * Golden fixtures for the zod 4 migration (GHSA-mrhx-c7xc-m3w5, PR B): tokens
 * this server issued **before** the deploy must still verify after it. A stamp
 * or a flash lives in an open browser tab across a release; if the zod 4 parse
 * of its payload differed, a person mid-command would be refused (or, worse,
 * a stamp that should be refused would pass).
 *
 * `ISSUED` holds the exact bytes today's code mints for the inputs below, and
 * the snapshot beside this file what each verifies to — both recorded under
 * **zod 3.25.76**, the oracle B is measured against. Never re-record either to
 * make a migration pass: a difference is a behaviour change, fixed in the code.
 */

const SESSION: WebSession = {
  subject: 'USR_1',
  username: 'manager',
  organizationId: 'ORG_1',
  accessToken: 'access-token-value',
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'refresh-token-value',
  csrfToken: 'csrf-token-for-this-session',
  issuedAt: 1_900_000_000,
};

const ENV = {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
};

const NOW = 1_800_000_000_000;

const REPLAY_ENV = {
  WEB_CONTRACT_IDEMPOTENCY_TTL_HOURS: 24,
  WEB_CONTRACT_REPLAY_MARGIN_SECONDS: 600,
};

const TARGETS: Record<string, ContractTarget> = {
  sign: {
    command: 'SIGN',
    contractId: 'CTR-1',
    subjectId: null,
    expectedVersion: 3,
    side: 'EMPLOYER',
  },
  cancel: {
    command: 'CANCEL',
    contractId: 'CTR-1',
    subjectId: null,
    expectedVersion: 1,
    side: null,
  },
  proposeAmendment: {
    command: 'PROPOSE_AMENDMENT',
    contractId: 'CTR-1',
    subjectId: null,
    expectedVersion: 4,
    side: null,
  },
  signAmendment: {
    command: 'SIGN_AMENDMENT',
    contractId: 'CTR-1',
    subjectId: 'AMD-1',
    expectedVersion: 1,
    side: 'CONTRACTOR',
  },
  planMilestone: {
    command: 'PLAN_MILESTONE',
    contractId: 'CTR-1',
    subjectId: null,
    expectedVersion: null,
    side: null,
  },
  changeMilestone: {
    command: 'CHANGE_MILESTONE',
    contractId: 'CTR-1',
    subjectId: 'MLS-1',
    expectedVersion: 7,
    side: null,
  },
};

/** Payloads signed by hand: what `verifyPayload`'s envelope and strict parse make of each. */
const ENVELOPES: Record<string, Record<string, unknown>> = {
  exact: { id: 'AST-1', version: 2, note: null },
  persian: { id: 'AST-۱', version: 1, note: 'یادداشت' },
  extraKey: { id: 'AST-1', version: 2, note: null, injected: true },
  missingNullable: { id: 'AST-1', version: 2 },
  fractionalVersion: { id: 'AST-1', version: 2.5, note: null },
  textVersion: { id: 'AST-1', version: '2', note: null },
};

const ISSUED: Record<string, string> = {
  sign: 'eyJjb250cmFjdElkIjoiQ1RSLTEiLCJzdWJqZWN0SWQiOm51bGwsInN1Ym1pc3Npb25JZCI6IlNVQi1zaWduIiwiY29tbWFuZCI6IlNJR04iLCJpc3N1ZWRBdCI6MTgwMDAwMDAwMDAwMCwidW50aWwiOjE4MDAwODU4MDAwMDAsImV4cGVjdGVkVmVyc2lvbiI6Mywic2lkZSI6IkVNUExPWUVSIiwiZXhwIjoxODAwMDg1ODAwfQ.ZKteYajdiO7Zn4aFrX9ANG9Ot4iU3QNE3nCYC4zr660',
  cancel:
    'eyJjb250cmFjdElkIjoiQ1RSLTEiLCJzdWJqZWN0SWQiOm51bGwsInN1Ym1pc3Npb25JZCI6IlNVQi1jYW5jZWwiLCJjb21tYW5kIjoiQ0FOQ0VMIiwiaXNzdWVkQXQiOjE4MDAwMDAwMDAwMDAsInVudGlsIjoxODAwMDg1ODAwMDAwLCJleHBlY3RlZFZlcnNpb24iOjEsInNpZGUiOm51bGwsImV4cCI6MTgwMDA4NTgwMH0.uQ2XufelD-c9f8V95eVeT8K31tbY3PNsxovABgIXrKE',
  proposeAmendment:
    'eyJjb250cmFjdElkIjoiQ1RSLTEiLCJzdWJqZWN0SWQiOm51bGwsInN1Ym1pc3Npb25JZCI6IlNVQi1wcm9wb3NlQW1lbmRtZW50IiwiY29tbWFuZCI6IlBST1BPU0VfQU1FTkRNRU5UIiwiaXNzdWVkQXQiOjE4MDAwMDAwMDAwMDAsInVudGlsIjoxODAwMDg1ODAwMDAwLCJleHBlY3RlZFZlcnNpb24iOjQsInNpZGUiOm51bGwsImV4cCI6MTgwMDA4NTgwMH0.twMd9FjMqr8544mpEhrknpMnUseSk_gyhwv-cDtFOG0',
  signAmendment:
    'eyJjb250cmFjdElkIjoiQ1RSLTEiLCJzdWJqZWN0SWQiOiJBTUQtMSIsInN1Ym1pc3Npb25JZCI6IlNVQi1zaWduQW1lbmRtZW50IiwiY29tbWFuZCI6IlNJR05fQU1FTkRNRU5UIiwiaXNzdWVkQXQiOjE4MDAwMDAwMDAwMDAsInVudGlsIjoxODAwMDg1ODAwMDAwLCJleHBlY3RlZFZlcnNpb24iOjEsInNpZGUiOiJDT05UUkFDVE9SIiwiZXhwIjoxODAwMDg1ODAwfQ.dH86rxD31BuOCDweWN-Qyn4JmQ9vgOLn_va_ULVhjgg',
  planMilestone:
    'eyJjb250cmFjdElkIjoiQ1RSLTEiLCJzdWJqZWN0SWQiOm51bGwsInN1Ym1pc3Npb25JZCI6IlNVQi1wbGFuTWlsZXN0b25lIiwiY29tbWFuZCI6IlBMQU5fTUlMRVNUT05FIiwiaXNzdWVkQXQiOjE4MDAwMDAwMDAwMDAsInVudGlsIjoxODAwMDg1ODAwMDAwLCJleHBlY3RlZFZlcnNpb24iOm51bGwsInNpZGUiOm51bGwsImV4cCI6MTgwMDA4NTgwMH0.jAq2ZWYnsq7rh0eYC90omL2osI2jAioL7bU3JRj-m8I',
  changeMilestone:
    'eyJjb250cmFjdElkIjoiQ1RSLTEiLCJzdWJqZWN0SWQiOiJNTFMtMSIsInN1Ym1pc3Npb25JZCI6IlNVQi1jaGFuZ2VNaWxlc3RvbmUiLCJjb21tYW5kIjoiQ0hBTkdFX01JTEVTVE9ORSIsImlzc3VlZEF0IjoxODAwMDAwMDAwMDAwLCJ1bnRpbCI6MTgwMDA4NTgwMDAwMCwiZXhwZWN0ZWRWZXJzaW9uIjo3LCJzaWRlIjpudWxsLCJleHAiOjE4MDAwODU4MDB9.QNS0Pqua_PysuMY9xx3CtUBoc4lD738TCdZvQY7Ki3c',
  flash:
    'eyJzdWJqZWN0IjoiQ1RSLTEiLCJhY3Rpb24iOiJTSUdORUQiLCJleHAiOjE4MDAwMDAxMjB9.79fsX_i77otj0CUp-1aHPvNVUreoi_eZyEIIACRm6Po',
  exact:
    'eyJpZCI6IkFTVC0xIiwidmVyc2lvbiI6Miwibm90ZSI6bnVsbCwiZXhwIjoxODAwMDAzNjAwfQ.5ea02EJgxuQ2JoK_V_J-JsMl7IWcS9G2A_BosToKL7U',
  persian:
    'eyJpZCI6IkFTVC3bsSIsInZlcnNpb24iOjEsIm5vdGUiOiLbjNin2K_Yr9in2LTYqiIsImV4cCI6MTgwMDAwMzYwMH0.svYyqC5a7jvstqCQMcBsItIC4ebL8S-5NZAhAiBUwDU',
  extraKey:
    'eyJpZCI6IkFTVC0xIiwidmVyc2lvbiI6Miwibm90ZSI6bnVsbCwiaW5qZWN0ZWQiOnRydWUsImV4cCI6MTgwMDAwMzYwMH0.WzaK_RgbdSRikSEv3O69X7VTZdBmGP9_V8I1M-NIFuQ',
  missingNullable:
    'eyJpZCI6IkFTVC0xIiwidmVyc2lvbiI6MiwiZXhwIjoxODAwMDAzNjAwfQ.3Ec-B_980hPxhI0P9zfHbe1dqML7lmVQICzVvHuRnpk',
  fractionalVersion:
    'eyJpZCI6IkFTVC0xIiwidmVyc2lvbiI6Mi41LCJub3RlIjpudWxsLCJleHAiOjE4MDAwMDM2MDB9.5viWham_k3Gzc4J0WW3YRm3l15PPuaVFbM7_4dn_Wo8',
  textVersion:
    'eyJpZCI6IkFTVC0xIiwidmVyc2lvbiI6IjIiLCJub3RlIjpudWxsLCJleHAiOjE4MDAwMDM2MDB9.wL-jvy88yVAZsjcF128_QSUejFZh0t71cwUr3MMvsEY',
};

const BASELINE = z.object({
  id: z.string().min(1),
  version: z.number().int().min(1),
  note: z.string().nullable(),
});

describe('zod-3 golden: signed tokens issued before the deploy', () => {
  const original = { ...process.env };
  beforeEach(() => {
    Object.assign(process.env, ENV);
  });
  afterAll(() => {
    process.env = original;
  });

  it('today’s code mints exactly the recorded bytes', () => {
    const minted: Record<string, string> = {};
    for (const [name, target] of Object.entries(TARGETS)) {
      minted[name] = mintContractStamp(SESSION, target, `SUB-${name}`, NOW, REPLAY_ENV).token;
    }
    minted.flash = mintFlash(SESSION, 'CTR-1', 'SIGNED', NOW);
    for (const [name, payload] of Object.entries(ENVELOPES)) {
      minted[name] = signPayload(SESSION, 'golden', payload, 3600, NOW);
    }
    expect(minted).toEqual(ISSUED);
  });

  it('contract-command stamps verify to what they bound', () => {
    const later = NOW + 60_000;
    const verified = Object.fromEntries(
      Object.entries(TARGETS).map(([name, target]) => [
        name,
        verifyContractStamp(
          SESSION,
          ISSUED[name],
          scopeOfTarget(target),
          `SUB-${name}`,
          later,
          REPLAY_ENV,
        ),
      ]),
    );
    expect(verified).toMatchSnapshot();
  });

  it('a flash verifies for its record and action only', () => {
    expect({
      same: readFlash(SESSION, ISSUED.flash, 'CTR-1', ['SIGNED', 'CANCELLED'], NOW),
      otherAction: readFlash(SESSION, ISSUED.flash, 'CTR-1', ['CANCELLED'], NOW),
      otherRecord: readFlash(SESSION, ISSUED.flash, 'CTR-2', ['SIGNED'], NOW),
    }).toMatchSnapshot();
  });

  it('the envelope and the strict parse of a hand-signed payload', () => {
    const verified = Object.fromEntries(
      Object.keys(ENVELOPES).map((name) => [
        name,
        verifyPayload(SESSION, 'golden', ISSUED[name], BASELINE, NOW + 1_000) ?? 'refused',
      ]),
    );
    expect(verified).toMatchSnapshot();
  });

  it('expiry boundaries: the last millisecond that verifies and the first that does not', () => {
    // From the recorded tokens: a hand-signed payload's `exp` is 1800003600 (s),
    // the flash's 1800000120, and a stamp's signed `exp` and replay window both
    // end at 1800085800000 ms (24 h TTL − 600 s margin from NOW).
    const PAYLOAD_EXP_MS = 1_800_003_600_000;
    const FLASH_EXP_MS = 1_800_000_120_000;
    const STAMP_END_MS = 1_800_085_800_000;
    const stamp = (now: number) =>
      verifyContractStamp(
        SESSION,
        ISSUED.sign,
        scopeOfTarget(TARGETS.sign),
        'SUB-sign',
        now,
        REPLAY_ENV,
      ) ?? 'refused';
    expect({
      payloadAtExp: verifyPayload(SESSION, 'golden', ISSUED.exact, BASELINE, PAYLOAD_EXP_MS),
      payloadAfterExp:
        verifyPayload(SESSION, 'golden', ISSUED.exact, BASELINE, PAYLOAD_EXP_MS + 1) ?? 'refused',
      flashAtExp: readFlash(SESSION, ISSUED.flash, 'CTR-1', ['SIGNED'], FLASH_EXP_MS),
      flashAfterExp:
        readFlash(SESSION, ISSUED.flash, 'CTR-1', ['SIGNED'], FLASH_EXP_MS + 1) ?? 'refused',
      stampAtEnd: stamp(STAMP_END_MS),
      stampAfterEnd: stamp(STAMP_END_MS + 1),
    }).toMatchSnapshot();
  });
});
