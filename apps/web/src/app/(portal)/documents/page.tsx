import type { ReactNode } from 'react';
import { RequireSession } from '@/components/require-session';
import { DocumentsView } from '@/components/documents/documents-view';

/** LIVE — `GET /v1/documents` through the API Gateway. */
export default function Page(): ReactNode {
  return (
    <RequireSession requireOrganization>
      <DocumentsView />
    </RequireSession>
  );
}
