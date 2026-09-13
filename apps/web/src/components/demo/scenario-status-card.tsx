'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  PRESENTATION_PERSONAS,
  SCENARIO_STAGES,
  ScenarioProvider,
  useScenario,
  type PresentationPersona,
  type ScenarioStage,
} from '@/lib/demo/scenario';
import { formatInteger } from '@/lib/format';
import { Badge, Button, Card, cx } from '../ui/primitives';
import { Code } from '../ui/data-view';
import { PERSONA_LABELS, STAGE_LABELS, STORY_STEPS } from './scenario-copy';

/**
 * The central scenario hub on `/demo`: name, stage, revision, persona choice
 * and a compact 8-stage stepper with the one next destination the current
 * stage owes the presenter.
 *
 * No raw state dump — the task this engine was built for is explicit that
 * the investor-facing UI must not expose the snapshot as JSON. A presenter
 * gets the facts below, in Persian, plus links into the real screens where
 * every actual action control lives; the engine's own correctness is what
 * the test suite vouches for.
 */
function ScenarioStatusCardInner(): ReactNode {
  const { snapshot, dispatch } = useScenario();
  const currentIndex = SCENARIO_STAGES.indexOf(snapshot.stage);
  const currentStep = STORY_STEPS[currentIndex];

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-[var(--tx3)]">سناریوی نمایشی</p>
          <p className="mt-0.5 text-sm font-bold text-[var(--tx)]">
            {STAGE_LABELS[snapshot.stage]}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="info">
            <span>بازبینی</span>
            <span dir="ltr" className="rasta-code">
              {formatInteger(snapshot.revision)}
            </span>
          </Badge>
          <Code>{snapshot.scenarioId}</Code>
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--bd)] pt-4">
        <p className="mb-2 text-xs font-semibold text-[var(--tx3)]">نقش ارائه</p>
        <div role="group" aria-label="انتخاب نقش ارائه" className="flex flex-wrap gap-2">
          {PRESENTATION_PERSONAS.map((persona) => (
            <PersonaButton
              key={persona}
              persona={persona}
              active={snapshot.persona === persona}
              onSelect={() => dispatch({ type: 'PERSONA_SELECTED', persona })}
            />
          ))}
        </div>
      </div>

      <div className="mt-4 border-t border-[var(--bd)] pt-4">
        <p className="mb-2 text-xs font-semibold text-[var(--tx3)]">مسیر داستان</p>
        <ol className="flex flex-wrap items-center gap-1.5" aria-label="مراحل سناریوی نمایشی">
          {SCENARIO_STAGES.map((stage, index) => (
            <StageChip
              key={stage}
              stage={stage}
              status={
                index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming'
              }
            />
          ))}
        </ol>

        {currentStep ? (
          <div className="mt-3 rounded-[var(--radius-md)] border border-[var(--pri)] bg-[var(--pri-soft)] px-3 py-2">
            <p className="text-sm text-[var(--pri-tx)]">{currentStep.summary}</p>
            <Link
              href={currentStep.nextHref}
              className="mt-1 inline-flex min-h-[var(--tap)] items-center text-sm font-bold text-[var(--pri-tx)] hover:underline"
            >
              گام بعدی: {currentStep.nextLabel} ←
            </Link>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function PersonaButton({
  persona,
  active,
  onSelect,
}: {
  persona: PresentationPersona;
  active: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <Button
      variant={active ? 'primary' : 'secondary'}
      onClick={onSelect}
      ariaLabel={PERSONA_LABELS[persona]}
    >
      {active ? <span aria-hidden="true">✓ </span> : null}
      {PERSONA_LABELS[persona]}
    </Button>
  );
}

function StageChip({
  stage,
  status,
}: {
  stage: ScenarioStage;
  status: 'done' | 'current' | 'upcoming';
}): ReactNode {
  return (
    <li>
      <span
        aria-current={status === 'current' ? 'step' : undefined}
        title={status === 'upcoming' ? `هنوز نرسیده: ${STAGE_LABELS[stage]}` : STAGE_LABELS[stage]}
        className={cx(
          'flex min-h-[var(--tap)] items-center gap-1 rounded-[var(--radius-md)] border px-2.5 text-xs font-semibold',
          status === 'current'
            ? 'border-[var(--pri)] bg-[var(--pri)] text-white'
            : status === 'done'
              ? 'border-[var(--ok)] bg-[var(--ok-soft)] text-[var(--ok-tx)]'
              : 'border-[var(--control-border)] text-[var(--tx3)]',
        )}
      >
        {status === 'done' ? <span aria-hidden="true">✓</span> : null}
        {STAGE_LABELS[stage]}
      </span>
    </li>
  );
}

export default function ScenarioStatusCard(): ReactNode {
  return (
    <ScenarioProvider>
      <ScenarioStatusCardInner />
    </ScenarioProvider>
  );
}
