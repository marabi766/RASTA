import type { ReactNode } from 'react';
import { AuditDetailView } from '@/components/audit/audit-detail-view';
import { RequireSession } from '@/components/require-session';

/** BETA — `GET /v1/audit-events/{id}` (AUD-001–002). */
export default async function Page({
  params,
}: {
  params: Promise<{ auditEventId: string }>;
}): Promise<ReactNode> {
  const { auditEventId } = await params;

  return (
    <RequireSession>
      <AuditDetailView auditEventId={auditEventId} />
    </RequireSession>
  );
}
