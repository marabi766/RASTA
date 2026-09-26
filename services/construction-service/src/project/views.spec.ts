import { Prisma, type Project, type ProjectNeed } from '../generated/prisma';
import { toNeedView, toProjectSummaryView, toProjectView } from './views';

const AT = new Date('2026-09-26T08:00:00.000Z');

const PROJECT: Project = {
  id: 'PRJ_1',
  organizationId: 'ORG_A',
  title: 'Road',
  operationType: 'road',
  scopeOfWork: 'Resurface',
  locationDescription: 'North',
  estimatedCostMinor: 9_223_372_036_854_775_807n,
  status: 'DRAFT',
  statusReason: null,
  statusChangedAt: AT,
  statusChangedBy: 'USR_1',
  createdAt: AT,
  createdBy: 'USR_1',
  createdCorrelationId: 'corr',
  updatedAt: AT,
  updatedBy: 'USR_1',
  version: 3,
};

const NEED: ProjectNeed = {
  id: 'PND_1',
  organizationId: 'ORG_A',
  projectId: 'PRJ_1',
  title: 'Asphalt',
  description: 'Hot mix',
  quantity: new Prisma.Decimal('12.5000'),
  unit: 't',
  estimatedCostMinor: null,
  status: 'SUBMITTED',
  createdAt: AT,
  createdBy: 'USR_1',
  createdCorrelationId: 'corr',
  updatedAt: AT,
  updatedBy: 'USR_1',
  submittedAt: AT,
  submittedBy: 'USR_1',
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawalReason: null,
  version: 2,
};

describe('views', () => {
  it('sends money as an exact decimal string, even beyond 2^53', () => {
    expect(toProjectSummaryView(PROJECT, false).estimatedCostMinor).toBe('9223372036854775807');
  });

  it('sends a null estimate as null', () => {
    expect(
      toProjectSummaryView({ ...PROJECT, estimatedCostMinor: null }, false).estimatedCostMinor,
    ).toBeNull();
  });

  it('sends time as ISO-8601 UTC and carries the version for the next change', () => {
    const view = toProjectSummaryView(PROJECT, true);
    expect(view.createdAt).toBe('2026-09-26T08:00:00.000Z');
    expect(view.version).toBe(3);
    expect(view.hasArea).toBe(true);
  });

  it('keeps the polygon and prose out of the summary', () => {
    const view = toProjectSummaryView(PROJECT, true) as Record<string, unknown>;
    expect(view.area).toBeUndefined();
    expect(view.scopeOfWork).toBeUndefined();
  });

  it('derives hasArea in the detail view from the area itself', () => {
    const summary = { draft: 0, submitted: 1, withdrawn: 0 };
    expect(toProjectView(PROJECT, null, summary).hasArea).toBe(false);
    expect(
      toProjectView(PROJECT, { type: 'Polygon', coordinates: [[[0, 0]]] }, summary).hasArea,
    ).toBe(true);
    expect(toProjectView(PROJECT, null, summary).needsSummary).toEqual(summary);
  });

  it('sends a quantity in plain decimal notation, normalised', () => {
    expect(toNeedView(NEED).quantity).toBe('12.5');
    expect(
      toNeedView({ ...NEED, quantity: new Prisma.Decimal('99999999999999.9999') }).quantity,
    ).toBe('99999999999999.9999');
    expect(toNeedView({ ...NEED, quantity: new Prisma.Decimal('0.0001') }).quantity).toBe('0.0001');
    expect(toNeedView({ ...NEED, quantity: null }).quantity).toBeNull();
  });

  it('carries the submission and leaves the absent withdrawal null', () => {
    const view = toNeedView(NEED);
    expect(view.submittedAt).toBe('2026-09-26T08:00:00.000Z');
    expect(view.withdrawnAt).toBeNull();
  });
});
