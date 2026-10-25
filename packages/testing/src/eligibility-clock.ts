import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { RawSqlClient } from './runtime-role';

type TestPrisma = { client: Pick<RawSqlClient, '$executeRawUnsafe'> };

/**
 * Millisecond timestamp columns round now() forward as well as backward.
 * Use a full second of margin for cross-statement eligibility, never a zero
 * lease/backoff. Exact boundary tests instead need one transaction and clock.
 * Only the explicitly supplied fixture ids are changed, in this service's DB.
 */
export async function expireClaim(
  prisma: TestPrisma,
  ids: readonly string[],
  table: 'outbox_message' | 'notification_intent' = 'outbox_message',
): Promise<void> {
  const sql = {
    outbox_message: `UPDATE outbox_message SET claim_expires_at = now() - interval '1 second'
      WHERE id = ANY($1::text[])`,
    notification_intent: `UPDATE notification_intent SET claim_expires_at = now() - interval '1 second'
      WHERE id = ANY($1::text[])`,
  };
  assert.ok(Object.hasOwn(sql, table), 'unknown eligibility table');
  const updated = await prisma.client.$executeRawUnsafe(sql[table], [...ids]);
  assert.equal(updated, new Set(ids).size, 'expireClaim must update every requested fixture');
}

/** The allowlist keeps SQL identifiers static; ids remain bound parameters. */
export async function makeDue(
  prisma: TestPrisma,
  ids: readonly string[],
  table: 'outbox_message' | 'policy_reconciliation_task' = 'outbox_message',
): Promise<void> {
  const sql = {
    outbox_message: `UPDATE outbox_message SET next_attempt_at = now() - interval '1 second'
      WHERE id = ANY($1::text[])`,
    policy_reconciliation_task: `UPDATE policy_reconciliation_task
      SET next_attempt_at = now() - interval '1 second' WHERE id = ANY($1::text[])`,
  };
  assert.ok(Object.hasOwn(sql, table), 'unknown eligibility table');
  const updated = await prisma.client.$executeRawUnsafe(sql[table], [...ids]);
  assert.equal(updated, new Set(ids).size, 'makeDue must update every requested fixture');
}

// Cross-statement fixture mutations. Every selector is a single-row unique key;
// the pending-task variant also retains the original status refusal.
const fixtures = {
  resolutionDue: `UPDATE notification_intent SET next_resolution_at = now() - interval '1 second' WHERE id = ANY($1::text[])`,
  resolutionParked: `UPDATE notification_intent SET next_resolution_at = now() + interval '24 hours' WHERE id = ANY($1::text[])`,
  policyReleased: `UPDATE policy_reconciliation_task SET lease_until = NULL, lease_token = NULL WHERE id = ANY($1::text[]) AND status = 'PENDING'`,
  awardDue: `UPDATE tender_award_standing_check SET next_attempt_at = now() - interval '1 second' WHERE tender_id = ANY($1::text[])`,
  awardExpired: `UPDATE tender_award_standing_check SET lease_until = now() - interval '1 second' WHERE tender_id = ANY($1::text[])`,
  tenderDue: `UPDATE tender SET close_next_attempt_at = now() - interval '1 second' WHERE id = ANY($1::text[])`,
  tenderExpired: `UPDATE tender SET close_lease_until = now() - interval '1 second' WHERE id = ANY($1::text[])`,
  scanDue: `UPDATE document SET scan_next_attempt_at = now() - interval '1 second' WHERE id = ANY($1::text[])`,
  scanExpired: `UPDATE document SET scan_lease_expires_at = now() - interval '1 second' WHERE id = ANY($1::text[])`,
  paymentPendingDue: `UPDATE payment_reconciliation_task SET next_attempt_at = now() - interval '1 second' WHERE id = ANY($1::text[]) AND status = 'PENDING'`,
  paymentDue: `UPDATE payment_reconciliation_task SET next_attempt_at = now() - interval '1 second' WHERE id = ANY($1::text[])`,
  paymentExpired: `UPDATE payment_reconciliation_task SET lease_until = now() - interval '1 second' WHERE id = ANY($1::text[])`,
  paymentReleasedDue: `UPDATE payment_reconciliation_task SET lease_until = NULL, lease_token = NULL, next_attempt_at = now() - interval '1 second' WHERE id = ANY($1::text[])`,
  outboxLeasedPast: `UPDATE outbox_message SET claim_token = 'old', claim_owner = 'old', claim_expires_at = now() - interval '1 minute' WHERE id = ANY($1::text[])`,
  outboxRetryPast: `UPDATE outbox_message SET next_attempt_at = now() - interval '1 minute' WHERE id = ANY($1::text[])`,
  outboxPairedPast: `UPDATE outbox_message SET claim_token = 'old', claim_owner = 'old', claim_expires_at = now() - interval '1 minute', next_attempt_at = now() - interval '1 minute' WHERE id = ANY($1::text[])`,
} as const;

/** A static statement allowlist; no caller-supplied SQL, identifiers or clock values. */
export async function setEligibilityFixture(
  prisma: TestPrisma,
  fixture: keyof typeof fixtures,
  ids: readonly string[],
): Promise<void> {
  assert.ok(Object.hasOwn(fixtures, fixture), 'unknown eligibility fixture');
  const updated = await prisma.client.$executeRawUnsafe(fixtures[fixture], [...ids]);
  assert.equal(
    updated,
    new Set(ids).size,
    'setEligibilityFixture must update every requested fixture',
  );
}

/**
 * Existing boundary, constraint, migration and fixed-seed SQL probes. Hashes
 * cover every raw template segment, not a substring or a whole-file exemption.
 * New fixture mutations belong in setEligibilityFixture, with a row count.
 * Exact boundary probes intentionally share their transaction's clock; this
 * allowlist does not grant a general permission to write now() or JS dates.
 */
const reviewedClockTemplates = [
  '987b8386fb52cd9e95015f92a4612940004ad543cbe9fe30116d8b62b400bf94', // services/supplier-service/test/outbox-purge.int-spec.ts:96
  '9af53146f478fbb5eaa1e9b969ba1c09aed8d7d6eef5a2f2812aa9a1f62f0103', // services/construction-service/test/refusal-contract.int-spec.ts:70
  'c260ccfcf6e9794efbb4e6bb5cf4116e28b9c3a2c83ed686ab2730f9c3b6785e', // services/construction-service/test/award.int-spec.ts:1881
  '3ecc4f3bb93dd41c8321587b229bfac398817a448a622ddde6a9fd8e0a28223d', // services/construction-service/test/award.int-spec.ts:1887
  '24dadd7ac8fc8d7a37fa243edc22e8c731600cff3396f08da9a6bc09d99ef059', // services/construction-service/test/award.int-spec.ts:1896
  '3343d4a9b4e0b855d6a4645894f92352069b883fa39ab57730a9fae9464deddf', // services/construction-service/test/award.int-spec.ts:1891
  '4df7b94249a7eb3653e6a4b430af14595f4753a6b22d0f6fcab432cf16083dd9', // services/construction-service/test/award.int-spec.ts:1898
  'f48d9668c749695d3b30c412583f187b9e2929752046c162589a9de6102462d6', // services/construction-service/test/award.int-spec.ts:1903
  '4d35ab65a41c564a125afef4e9f38f338f94fa7f10ff554651a434cc140f52c6', // services/construction-service/test/award.int-spec.ts:1910
  'e5dba72ed7c43ab17980f2a3154ca87519c812010b4ffb3713e976d0d8ea9893', // services/construction-service/test/award.int-spec.ts:1918
  '0c90cf0346b7d8cc1db6d7efbebfce816fc8b02dd0becbc998d52c8536fd962c', // services/construction-service/test/award.int-spec.ts:1925
  'ce8164d147c919ec4e4ffdc83a6490191248c750328029702707b786b5e3b33e', // services/construction-service/test/award.int-spec.ts:1939
  '4c237be4d29448522bc05ebceab535b63255b03008250793c4ef9fc0b5a08dcd', // services/construction-service/test/award.int-spec.ts:1941
  '4a7655195c334c277fd43908467196b3791494548001a438b18c6071f7a896ae', // services/construction-service/test/bids.int-spec.ts:332
  '25b85eb1caff82a41e90f874f4863cb35d587cda3d33dd81e09c482bed6fb35a', // services/construction-service/test/bids.int-spec.ts:274
  '4e310bb24859f366b084c731a8ef8ec803c601265a9de86c747c15974a69a467', // services/construction-service/test/bids.int-spec.ts:781
  '5943671e8e48f101ddddf70a58bbd368b4ce5472558cca4e4b1c6b616ac94da7', // services/construction-service/test/criteria.int-spec.ts:412
  'c40b532a801218e266cd9a2eec75649ddd8f4db426aa494420cb50a4224d87f1', // services/construction-service/test/criteria.int-spec.ts:544
  'c122ef59b677b734456d41f08216e95bc01a1cd12fd39fff2121e3aa4f6fe875', // services/construction-service/test/tender-open.int-spec.ts:134
  '93d7e7513f1d34f62890a9803e049f30cd26d70ccff4bf6107dc5903fdb93aed', // services/construction-service/test/publication.int-spec.ts:685
  '65b249bbe1f49d894bb62ff0552510a023b16d8878b656f930410572fe5fac96', // services/construction-service/test/tender-close.int-spec.ts:103
  '68923fe685a601620c3e31f85bcf1be97d7b04b3b22814baf9bb6e11b733428d', // services/construction-service/test/tender-close.int-spec.ts:240
  '3acae66fc6aa77e8f937e9ce8dcd350e6aa0598c392e596000b02dea8297fa62', // services/construction-service/test/tender-close.int-spec.ts:388
  '5d55777e7083b140e86016535a44d4eeb7777b8166f34028442e50cd7494d8e9', // services/construction-service/test/tender-close.int-spec.ts:432
  'd7045ca78fd579ae58714686919c37ff06481c5628b7d1025c5825a018588a4f', // services/construction-service/test/tender-close.int-spec.ts:462
  'b7600a14c3d71e6d74fc8e1bb4b865ae5ec9b12eca8b9e408badadba59a758db', // services/construction-service/test/tender-close.int-spec.ts:487
  'c51edce4fbbf6473ad0a8248796b21d04b35ca71cae3f79790b3db29b400213e', // services/construction-service/test/tender-close.int-spec.ts:652
  'e01b59a889b5fa23045037ee8fb78a5a1600626c579a69060e5e4f2e73abbf8f', // services/construction-service/test/tender-open-scale.int-spec.ts:264
  'eec04302843c06a177141845938fa3c75d32a3e4254f6749dfa469ff89c06579', // services/construction-service/test/tender-open.int-spec.ts:530
  '312b8b609b988325c70234cc1f0488744e312e50650a8ffde79604e0c9eb70ff', // services/contract-service/test/migration-rollback.int-spec.ts:296
  'b3cf32bc31f181d3dfae74c2b5db26e5020278c9005ae40cc67500f972512401', // services/document-service/test/instants-timestamptz.int-spec.ts:63
  'd4e0cf0c47795d2e5d2517eaf59b3638a92b656eabe16796d668c08377a1fcc2', // services/document-service/test/instants-timestamptz.int-spec.ts:295
  'fc5c01c03650a69cc32e5a888537be3e92dfaf60295d92ace42fd362f355a5b3', // services/document-service/test/outbox-durable-claim.int-spec.ts:862
  'cff9cb1ae191730ad1a0e4dc201ff4b112e44afffa6f897ea1df1171a2916e4e', // services/document-service/test/outbox-durable-claim.int-spec.ts:866
  'a28b98f695b326cd564a0feb529d0b445cdc48e7adb34a2fc9c6a1480b5d6fa7', // services/document-service/test/outbox-durable-claim.int-spec.ts:1054
  '53af5cb5b2110f927ae5609c7f76c845399106315968639c97d4381cce7fc113', // services/document-service/test/outbox-durable-claim.int-spec.ts:1061
  '2d7da177915ca2717940a95b6e84553abaadda2af74a0c8b932583068adfcae2', // services/document-service/test/outbox-durable-claim.int-spec.ts:1221
  '481dfedcabf6112777f8ea117fe51cf9ae9c5e8a6fcc8d44fb8b4cca1b2961a8', // services/economic-service/test/payment-reconciler.int-spec.ts:799
  '642180a91a4b0b8c4d477772e2c34afef612d7b29267ba5596e5b922990b19c1', // services/economic-service/test/payment-reconciler.int-spec.ts:917
  'b9d2a6cadadc36001f4d020ec4b58bee655a62b0fc6b915efec4d7e85844e4b6', // services/economic-service/test/payment-reconciliation-operator.int-spec.ts:983
  '670fb1696f79567a9a4e92dcab81a569c845f5754d8c2df0f0337c02dd43b6ae', // services/economic-service/test/payment-reconciliation-operator.int-spec.ts:733
  '6d358503476f8ff3731285e8a524ee9aee1fbce9202e2343eb303f219c231e37', // services/economic-service/test/payment-reconciliation-operator.int-spec.ts:741
  '53db41eb5d06c4ed491a03814242fd76bc5432bc80935ed894817643918c4adc', // services/economic-service/test/payment-reconciliation-task.int-spec.ts:485
  'bdcad7b0314800761f25c40a0147cbfa6c9a6d35324f41657387a4733579e86f', // services/economic-service/test/payment-reconciliation-task.int-spec.ts:506
  '3a0b2d68ae890e1a9ba49763365ce05529d6ace1b8116e0a8d2eba838709e6ff', // services/fleet-service/test/insurance-parked.int-spec.ts:206
  '8a53fbf99da08af33858208b16523d7be6fafa3e9c3648f19be5d295412c7321', // services/identity-service/test/security-event-aggregation.int-spec.ts:579
  'ffd279f9cc6603d321c7f35cd850f479fe5deb24e8e197f68aa70b78b28eb976', // services/identity-service/test/security-event-aggregation.int-spec.ts:883
  '1e0735a8e6f85ebc5cd3c2962e0e78da378ddfc8fe4d81c9676433a3c0890b79', // services/identity-service/test/security-event-aggregation.int-spec.ts:896
  'c770dd9b4c148d85f64c5432973414d4b3729dac484cb33171cf890b622290c3', // services/notification-service/test/constraints.int-spec.ts:103
  '6d0bac79656285200351d4d54909d55210e10aa0b760bf7012681841799cba3e', // services/notification-service/test/constraints.int-spec.ts:248
  '029f21e3c3d86d0c147972a23ff88916299f33e9f0b6d1ab8675b3b78aa51204', // services/procurement-service/test/aggregation-setting.int-spec.ts:548
  '2213cbbf5934f9eab1d03213c6ff7194a206950eef1fe493351d8b4448fe1d33', // services/procurement-service/test/constraints.int-spec.ts:56
  'bc842ecdcbae074e446e80c0bfa02536b6c0326d9c743e835fe35c41c336453f', // services/procurement-service/test/constraints.int-spec.ts:152
  '0643626e7db302b7bca3deb90d7d2690920fd0c353a89f26652bcfa1791d938b', // services/procurement-service/test/constraints.int-spec.ts:180
  'e2c4cfb14c4a32021a43e4fbceaa5fe0d1cf99f8019a3954011b5d219d66b799', // services/procurement-service/test/constraints.int-spec.ts:270
  '92f65c77e1d062d6c6e497a8fa2c349eb2861c957afe939975207bcf212da0c0', // services/procurement-service/test/constraints.int-spec.ts:280
  '753864ef555406f4e4729d7bb0d3fd848cd03b4c290ddbc9257256dee448f0d7', // services/procurement-service/test/constraints.int-spec.ts:304
  '8e1d8405bfe8000097122c7349979e6bc012fd75d1de748a1234d8287cc6142a', // services/procurement-service/test/constraints.int-spec.ts:309
  '4a4d564508f6e5a726473119ab8c44bd328d7d8672487ba475d174f11456519e', // services/procurement-service/test/constraints.int-spec.ts:314
  '5a2146ac343e9e97f92e1445592453ed8fdaec9456284b66c82f075fcf4deccb', // services/procurement-service/test/constraints.int-spec.ts:487
  '91e7a601d5c57fcdf0a266456a4a2dcace0b833c1912a141e12e4032e3fce9db', // services/procurement-service/test/constraints.int-spec.ts:518
  '01f616301310baa606f35666e8a46a97758acea87abd3b14fa1516a511669502', // services/procurement-service/test/constraints.int-spec.ts:608
  '88e0d1fd916313a86d6c9164d5396322d717eea12ab74176022e91425637accb', // services/procurement-service/test/helpers.ts:99
  '36d7c99e61f7e176ac55d5ff7efeb078e42df0131b4abbf3dbe7ec5f00c3a50f', // services/procurement-service/test/rfq-close.int-spec.ts:200
  '86d2f8ffd2118554b345f1e231882ecbcfc8457eb93976a48afb01d3d700327e', // services/procurement-service/test/rfq-close.int-spec.ts:510
  '05b716c98b0817fb2eae528c197b60f9515ec626ddf84dd7235aee87e4440470', // services/procurement-service/test/rfq-constraints.int-spec.ts:94
  'e09e20f6f39805e7b9a54e6d29900049ee922cc61722edc36ce67b061c0c0a4f', // services/procurement-service/test/rfq-constraints.int-spec.ts:110
  '7c4f5d8c743f13646251ce1687e9bfef59d7a14415eddc3d86655fd6e875b82a', // services/procurement-service/test/rfq-constraints.int-spec.ts:181
  '42cc69e229b67e793df3039759e917bd0c398cbf79bd305938a486c6bee541d5', // services/procurement-service/test/rfq-constraints.int-spec.ts:181
  'b03ce4d70bdbdc5a70704f96360bcbb218befe397f94bd927df15c6e14d35cee', // services/procurement-service/test/rfq-constraints.int-spec.ts:205
  '517388ae85da04590f328429cd981d0ea89682940342ab8fd5af1cfbe972c526', // services/procurement-service/test/window-withdrawn-history.int-spec.ts:124
  'f823e0c418e7c263ec4f8d1812bcfc11a5c91717ef418f911b56d19b8b46ef15', // scripts/verify-migration-reversible-lib.mjs:238
  '03aec7c60e646f36a2dc811e52882afc408e0c392f92cc113e30887937279371', // scripts/verify-migration-reversible-lib.mjs:1558
  'e474523333d55e8cb9d03cd56c906801c16b7a6b8cbe9436d3d4ff059021efa9', // scripts/verify-outbox-claim-migration.mjs:610
  '1257d5bc7fc08f91ce73341a001762b0f3261e7405ea564536a81d46d39adedb', // scripts/verify-outbox-claim-migration.mjs:640
  '50c664e5c464325f578e02337a740b6ca6b700f1875e3c29fc75b2ae3d698621', // scripts/verify-outbox-claim-migration.mjs:646
  '6d35040d7a35f52277ba8f595655793e7181fc2515beaede1d5b66661520bd73', // scripts/verify-outbox-claim-migration.mjs:652
  'be2b329e738a2d981cb1f478efffe6498e071d0637a38ab440a5987b3b2e9c21', // scripts/verify-security-event-outbox-migration.mjs:548
  '36b33241f563eddbce5a4fd5be5a39c100c2c73bf185677ede160370257da3ad', // scripts/verify-security-event-outbox-migration.mjs:388
  '106b0b8c61861a6b30790fdb7ec73e929f6c32d7ac9bbe71c8de79cc3742ada4', // scripts/verify-security-event-outbox-migration.mjs:507
  '4d55ff12a91bcb3614ca7c5ea73b8a4dd0f6b090c1882146cf5dceb6d1bf1f34', // scripts/verify-security-event-outbox-migration.mjs:553
  'beec6b3b94ec6e046f94db6f9c67f4618c547589e65962a5976983b7a2e8fad8', // scripts/verify-security-event-outbox-migration.mjs:558
  '9505247de569290cf186b2f46cdb24e9f7798e36dab55ba30c45a1370c907aa9', // services/construction-service/test/award.int-spec.ts:1822
  '9505247de569290cf186b2f46cdb24e9f7798e36dab55ba30c45a1370c907aa9', // services/construction-service/test/award.int-spec.ts:1872
  'a69cf29cb765213b199eab090a78ecc11379c7a89d23266dfcfa9db11f0effd4', // services/construction-service/test/tender-constraints.int-spec.ts:71
  'a7229a7b59af48311a1f307a50b4a9f4d965d1b811f9986aab16b80f5cbb28b7', // services/economic-service/test/payment-reconciliation-operator.int-spec.ts:728
  '1d8fc6ceb1f94c6326d6d5483d258fcb2e179e9869325b245d105c2219bf69fd', // scripts/verify-outbox-claim-migration.mjs:224
  '49e53d9d56433a18a862bc7422a94679c35ec1a8b212983cdf88e5942bdc35f5', // scripts/verify-outbox-claim-migration.mjs:224
] as const;

/** Static SQL probe allowlist; unknown templates fail before any SQL executes. */
export function eligibilityClockSql(strings: TemplateStringsArray, ...values: unknown[]): string {
  void reviewedClockExpressions;
  const hash = createHash('sha256').update(JSON.stringify(strings.raw)).digest('hex');
  assert.ok(
    (reviewedClockTemplates as readonly string[]).includes(hash),
    'unreviewed eligibility SQL probe',
  );
  return strings.reduce(
    (sql, part, index) => sql + (index ? String(values[index - 1]) : '') + part,
    '',
  );
}

/** Keep Prisma's lazy promise and bound parameters for tagged SQL probes. */
export function eligibilityClockWrite<T>(client: {
  $executeRawUnsafe(query: string, ...values: unknown[]): T;
}): (strings: TemplateStringsArray, ...values: unknown[]) => T {
  return (strings, ...values) => {
    const hash = createHash('sha256').update(JSON.stringify(strings.raw)).digest('hex');
    assert.ok(
      (reviewedClockTemplates as readonly string[]).includes(hash),
      'unreviewed eligibility SQL probe',
    );
    const sql = strings.reduce(
      (query, part, index) => query + (index ? `$${index}` : '') + part,
      '',
    );
    return client.$executeRawUnsafe(sql, ...values);
  };
}

/** Preserve a Prisma.sql probe's parameter binding and result type. */
export function eligibilityClockTag<T>(
  tag: (strings: TemplateStringsArray, ...values: unknown[]) => T,
): (strings: TemplateStringsArray, ...values: unknown[]) => T {
  return (strings, ...values) => {
    const hash = createHash('sha256').update(JSON.stringify(strings.raw)).digest('hex');
    assert.ok(
      (reviewedClockTemplates as readonly string[]).includes(hash),
      'unreviewed eligibility SQL probe',
    );
    return tag(strings, ...values);
  };
}

const reviewedClockExpressions = [
  'dd7a441b22451fd424992192032f24c8f854c2d7e0544feb2710303b681db6ab',
  '6aafd1d75ba415239359e4b15a2644e6575a20946d0361cc932e3655f90fca2a',
  '899883601f20628a9cc75f94f380acc80e472c2cca864654a462aac1c25f20a2',
  '849928cf5ca5101f7014088a66a0463ba9395c29febf0fcdd0b0586e11248d7a',
  '742a414efdc82758d4585ca6f2a95d5f098056ac71c7b7d440cf133cffbee266',
  '5df7f5560e7636b3217e72f5d041212d848dddedf99a129cfd41abf8cd0a9438',
  '5563af7e1dc50403b910b19f5d4421f809eac8136b49d3eae04614afa0a7092f',
  '3591388ac4c1dc60b9d53f2c060c65d1e35fd98bb094140c71199ed203820d18',
  'a7a5495d17f75cfb38e400c910ad0da557da6a66679ea9d1bd1bd938bad833dc',
  'f313dd54ab9b6185add5e9afe0422db5060282b784f4a9ce1a748caee7171c7e',
  '67ae0fafe286d786a10b3ed1e9b8572445000a1f7b0a6530808294d027540fb1',
  '28face26d5fa9d00ea29c1fd8f1953937b59837ff38ac9d623591b6d6ff56b23',
  'a35547253058e2246c7876ba59f3c26aa5f180ba7713389ef1cea9a6f7bba146',
  '8bae0d6772e9f4fa7e1761dbe783484e4f4fcddc845472a4757e989e3e68b9be',
  '3e5e3275446675e7fe93aa1266a663553a604c5fd0310faae70dd98dc42429f0',
  'ee33ee51fd1673149d806a1af4f443ccf081e2cdace6c079fcb070634caecec9',
  '4a34ade02b98363c31ebc6c996f445b074ae3228a3140b10cc0fdad0cd0e7301',
  '066568281b9a4c55b686dad805f7e8b1c108330734825dba8e901288f75f6e09',
  'bd919f591b3956f3622a096227ce48440a4258151a4f11215242593f28de41ab',
  '918cf60cd7ab874d109ab3b77b6da1a88c98384714fff46568e700595f72e588',
  'f9cc8303518dfacfc48061bba6447eb115856f922093e0fdb105284347d99674',
  '396b428362b7af6da6f16a6e347e9a219d86000564731de663c142085fa467ff',
  'eae78cfc9278f1282055f5544166ebbae445e829e941e14eae3a43222ad89d29',
  '12283e3bedaff520129b627135b609a86fa4546923eabe4b2bef537c3ad74152',
  '329e25630dc7f6fe7c94327732eb43bea18988409bc88ede626ab3e4ea3ba54c',
  'a5e7bf001acb0f8558c47602a27368b6125be76a285d9599b033e159b53cefce',
  'c10972f5b2af5f31e30e7945d2c30332feb1738f08bfcdcffed2d8f2827bee3e',
  'b31fcc5dad451cab0e321fc776d4a886af25b49bd00e5052961cc261fcaecec8',
  '25e931abb01fa831b93ad869433b4065bc0c587932ffd170bde091a43257149d',
  'b9e18bdb8fc8c090cd2a9dfd4a461a09e838991978a90065eab57a90edaf268e',
  '535fac3dd69f998ddc24e31860d3b8a0ee49e614bf63ce12c799114885880f9f',
  'b000bfcdf184eda09fcb4fec55aa7fc053b5390f7970c1d25709f586dfbe6e67',
] as const;
