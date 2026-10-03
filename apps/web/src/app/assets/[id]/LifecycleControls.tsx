import type { ReactNode } from 'react';

import { Alert, ButtonLink } from '@/ui';
import {
  OPEN_WORK_NOTES,
  statusTargetsFrom,
  type AssetLifecycleCommand,
} from '@/lib/asset-lifecycle-fields';

import { ActivateAssetForm, ChangeStatusForm, DecommissionAssetForm } from './AssetLifecycleForms';

/**
 * What the page offers to do to a machine's life: commission it, change its
 * status, retire it.
 *
 * The page decides **which** commands to offer — a role it may use and a status
 * the transition table allows from — and signs a baseline for each
 * (`sealAssetLifecycleBaseline`); this renders exactly the ones it was given a
 * baseline for. So there is no role or status logic here to drift from the
 * page's, and a command with no token cannot be drawn.
 */

export interface LifecycleToken {
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  /** Signed for this command, this machine, its version and its status. */
  readonly baseline: string;
}

export interface LifecycleControlsProps {
  /** The page's asset, which every form binds its action to. */
  readonly assetId: string;
  readonly assetName: string;
  /** The status the page shows, which the choices are drawn from. */
  readonly status: string;
  readonly csrfToken: string;
  readonly tokens: Readonly<Partial<Record<AssetLifecycleCommand, LifecycleToken>>>;
}

function Block({
  headingId,
  title,
  children,
}: {
  headingId: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-semibold text-content">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function LifecycleControls({
  assetId,
  assetName,
  status,
  csrfToken,
  tokens,
}: LifecycleControlsProps) {
  const targets = statusTargetsFrom(status);
  const openWork = OPEN_WORK_NOTES[status];

  return (
    <div className="flex flex-col gap-8">
      {/* Work another service holds: the person is told whose it is and what to
          do first, instead of a form that would be refused (docs/24 Q-94). */}
      {openWork ? (
        <Alert
          tone="info"
          title={openWork.title}
          actions={
            <ButtonLink tone="secondary" href={openWork.href}>
              رفتن به بخش مربوط
            </ButtonLink>
          }
        >
          {openWork.text}
        </Alert>
      ) : null}

      {tokens.activate ? (
        <Block headingId="lifecycle-activate" title="فعال‌سازی">
          <ActivateAssetForm assetId={assetId} csrfToken={csrfToken} {...tokens.activate} />
        </Block>
      ) : null}

      {tokens.status && targets.length > 0 ? (
        <Block headingId="lifecycle-status" title="تغییر وضعیت">
          <ChangeStatusForm
            assetId={assetId}
            csrfToken={csrfToken}
            currentStatus={status}
            targets={targets}
            {...tokens.status}
          />
        </Block>
      ) : null}

      {tokens.decommission ? (
        <Block headingId="lifecycle-decommission" title="اسقاط">
          <DecommissionAssetForm
            assetId={assetId}
            csrfToken={csrfToken}
            assetName={assetName}
            {...tokens.decommission}
          />
        </Block>
      ) : null}
    </div>
  );
}
