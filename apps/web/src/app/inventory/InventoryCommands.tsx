'use client';

import { useEffect, useState } from 'react';

import type { InventoryCommand, InventoryScope } from '@/lib/inventory-commands';
import type { Binding } from '@/lib/unresolved-order';
import {
  restoreUnresolvedInventory,
  subscribeUnresolvedInventory,
  type RestoredInventory,
  type InventorySubmission,
} from '@/lib/unresolved-inventory';

import { InventoryCommandForm, unconfirmedFrom, type AdjustableItem } from './InventoryCommandForm';

export interface OfferedInventoryCommand {
  readonly command: InventoryCommand;
  readonly submission: InventorySubmission;
}

export interface InventoryCommandsProps {
  readonly scope: InventoryScope;
  /** What this viewer may issue now, each with a fresh submission (`server/inventory-commands.ts`). */
  readonly offered: readonly OfferedInventoryCommand[];
  readonly csrfToken: string;
  readonly binding: Binding;
  readonly sessionMaxAgeSeconds: number;
  /** The stock items an adjustment may name. */
  readonly items?: readonly AdjustableItem[];
  readonly pageHref: string;
  /** Said when there is nothing to offer and nothing unresolved; nothing is said when absent. */
  readonly emptyNote?: string;
}

/**
 * The inventory commands of one slot — the warehouse list, one warehouse or one
 * shipment — drawn only **after** this browser has been asked whether a command
 * there is still unresolved
 * (`lib/unresolved-inventory.ts`).
 *
 * If one is, and none of the forms drawn now is the one that sent it (a
 * reload), only its uncertainty view is drawn, whatever the page would now
 * offer — the outcome-unknown marker included: the same request is reconciled
 * under its original key before any fresh form, with a fresh key, is offered.
 * Nothing is drawn until that question is answered.
 *
 * The question is asked again **whenever the slot's record changes**, not only
 * on mount: when one of the forms drawn here is sent and its outcome is not
 * confirmed, every other form becomes view-only with the uncertainty notice
 * (`heldBy`) while the one in doubt keeps its own retry — same key, same body —
 * until a definite answer, or the person, resolves it.
 */
function targetOf(scope: InventoryScope): string {
  switch (scope.kind) {
    case 'WAREHOUSES':
      return '';
    case 'WAREHOUSE':
      return scope.warehouseId;
    case 'SHIPMENT':
      return scope.shipmentId;
  }
}

function scopeOf(kind: InventoryScope['kind'], target: string): InventoryScope {
  switch (kind) {
    case 'WAREHOUSES':
      return { kind };
    case 'WAREHOUSE':
      return { kind, warehouseId: target };
    case 'SHIPMENT':
      return { kind, shipmentId: target };
  }
}

export function InventoryCommands({
  scope,
  offered,
  csrfToken,
  binding,
  sessionMaxAgeSeconds,
  items,
  pageHref,
  emptyNote,
}: InventoryCommandsProps) {
  const [checked, setChecked] = useState<{
    readonly slot: string;
    readonly restored: RestoredInventory | null;
  } | null>(null);
  const { owner, session } = binding;
  const kind = scope.kind;
  const target = targetOf(scope);
  const slotKey = `${kind}.${target}`;

  useEffect(() => {
    const slot = scopeOf(kind, target);
    const read = () =>
      setChecked({
        slot: slotKey,
        restored: restoreUnresolvedInventory(slot, { owner, session }, sessionMaxAgeSeconds),
      });
    read();
    return subscribeUnresolvedInventory(read);
  }, [kind, target, slotKey, owner, session, sessionMaxAgeSeconds]);

  // What was read for another warehouse or shipment is not an answer for this one.
  if (checked === null || checked.slot !== slotKey) return null;

  const { restored } = checked;
  // A record of none of the forms drawn now — this page was drawn after it was
  // sent (a reload): only its uncertainty view. A record of one of them: that
  // form keeps it, in place, and the others wait (`heldBy`).
  const drawnHere =
    restored !== null &&
    offered.some(({ submission }) => submission.id === restored.entry.submissionId);
  if (restored && !drawnHere) {
    return (
      <div className="flex flex-col gap-4">
        <InventoryCommandForm
          key={restored.entry.submissionId}
          scope={scope}
          command={restored.entry.command}
          csrfToken={csrfToken}
          submissionId={restored.entry.submissionId}
          replay={restored.entry.replay}
          binding={binding}
          sessionMaxAgeSeconds={sessionMaxAgeSeconds}
          pageHref={pageHref}
          initial={unconfirmedFrom(restored)}
        />
      </div>
    );
  }

  if (offered.length === 0) {
    return emptyNote ? <p className="text-sm text-content-muted">{emptyNote}</p> : null;
  }
  return (
    <div className="flex flex-col gap-4">
      {offered.map(({ command, submission }) => (
        <InventoryCommandForm
          // A form is one submission: a page drawn again (a link to another
          // warehouse, another page of a list) brings fresh ids and stamps, and
          // the form that held the old ones, with its values and refusals, goes.
          key={`${slotKey}.${command}.${submission.id}`}
          scope={scope}
          command={command}
          csrfToken={csrfToken}
          submissionId={submission.id}
          replay={submission.replay}
          binding={binding}
          sessionMaxAgeSeconds={sessionMaxAgeSeconds}
          items={items}
          pageHref={pageHref}
          heldBy={restored?.entry.submissionId ?? null}
        />
      ))}
    </div>
  );
}
