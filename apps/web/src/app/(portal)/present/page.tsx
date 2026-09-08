import type { ReactNode } from 'react';
import { PageHeader } from '@/components/ui/primitives';
import { Walkthrough } from '@/components/present/walkthrough';
import { WALKTHROUGH_MINUTES } from '@/components/present/steps';
import { formatInteger } from '@/lib/format';

/**
 * Presentation mode.
 *
 * No session guard: the tour has to work before anyone signs in, because the
 * first thing a presenter does is open it and the second is sign in during
 * step two. Every step it links to enforces its own access.
 */
export default function PresentPage(): ReactNode {
  return (
    <>
      <PageHeader
        title="روایت هدایت‌شده"
        description={`یک مسیر ${formatInteger(WALKTHROUGH_MINUTES)} دقیقه‌ای در محصول، با ترتیب ثابت و نکتهٔ هر گام. کلید ← گام بعد، → گام پیش، و f حالت ارائه.`}
      />
      <Walkthrough />
    </>
  );
}
