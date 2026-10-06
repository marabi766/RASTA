import type { ReactNode } from 'react';

import { EmptyState, Identifier, IsolatedText, Section, StatusBadge } from '@/ui';
import { formatJalaliDateLong } from '@/lib/format';
import { documentKindLabel } from '@/lib/labels';
import { documentValidityAt, type AssetDocumentSummary } from '@/server/asset-documents';

/**
 * The machine's documents on `/assets/[id]` (EXP-002, slice 7): the references
 * asset-service keeps — title, kind, dates — and, for the roles that may, the
 * form that attaches another.
 *
 * Pure, like the dossier next to it: every state is reachable in a test.
 *
 * ## A list of references, not of files
 *
 * What is listed is what asset-service holds: a title, a kind, an optional
 * issue and expiry date, and the id of the document in document-service. This
 * slice does not download: a file is handed over only after document-service has
 * scanned it, through a short-lived signed URL the browser cannot be assumed to
 * reach, and that is a decision of its own.
 *
 * ## "Expired" is the server's judgement
 *
 * A document that carries an expiry is judged against `now`, the clock of the
 * server that drew the page, and the verdict is written into the markup. This
 * component has no hooks and is never a client component, so the visitor's clock
 * cannot move a document from expired to current on their screen. A document
 * with no expiry never expires.
 */

export interface AssetDocumentsProps {
  readonly documents: readonly AssetDocumentSummary[];
  /** The server's clock when the page was drawn. */
  readonly now: Date;
  /** The attach form, when this person may use it. */
  readonly attachForm?: ReactNode;
}

const VALIDITY_BADGE = {
  CURRENT: { status: 'ACTIVE', label: 'معتبر' },
  EXPIRED: { status: 'FAILED', label: 'منقضی' },
} as const;

function Pair({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-content-subtle">{term}</dt>
      <dd className="text-sm text-content">{children}</dd>
    </div>
  );
}

export function AssetDocuments({ documents, now, attachForm }: AssetDocumentsProps) {
  return (
    <Section
      headingId="documents"
      title="مدارک"
      description="مدارک این دارایی؛ خود فایل در سامانهٔ اسناد نگهداری می‌شود و این‌جا فقط ارجاع به آن دیده می‌شود."
    >
      {documents.length === 0 ? (
        <EmptyState
          title="مدرکی پیوست نشده"
          description="سند مالکیت، کارت ثبت، فاکتور خرید و مانند آن را می‌توان این‌جا پیوست کرد."
        />
      ) : (
        <ul className="flex flex-col gap-4" data-testid="document-list">
          {documents.map((document) => {
            const validity = documentValidityAt(document.expiresAt, now);
            return (
              <li
                key={document.id}
                data-document-title={document.title}
                data-validity={validity}
                className="flex flex-col gap-3 rounded-lg border border-border p-4"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {validity === 'NO_EXPIRY' ? null : (
                    <StatusBadge
                      status={VALIDITY_BADGE[validity].status}
                      label={VALIDITY_BADGE[validity].label}
                    />
                  )}
                  <span className="font-medium text-content">
                    <IsolatedText>{document.title}</IsolatedText>
                  </span>
                </div>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <Pair term="نوع مدرک">{documentKindLabel(document.kind)}</Pair>
                  {document.issuedAt ? (
                    <Pair term="تاریخ صدور">{formatJalaliDateLong(document.issuedAt)}</Pair>
                  ) : null}
                  {document.expiresAt ? (
                    <Pair term="تاریخ انقضا">{formatJalaliDateLong(document.expiresAt)}</Pair>
                  ) : null}
                  <Pair term="شناسهٔ سند">
                    <Identifier>{document.documentId}</Identifier>
                  </Pair>
                </dl>
              </li>
            );
          })}
        </ul>
      )}
      {attachForm}
    </Section>
  );
}
