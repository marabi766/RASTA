import type { ReactNode } from 'react';
import { UnderConstruction } from '@/components/under-construction';

/** Generated from the capability manifest entry `commissions`. Reads nothing, calls nothing. */
export default function Page(): ReactNode {
  return (
    <UnderConstruction
      capabilityKey="commissions"
      value={['کارمزد، مدل درآمدی پلتفرم است و باید شفاف، قابل پیکربندی و قابل ممیزی باشد.']}
      prerequisites={[
        'Q-08 — نرخ کارمزد — هنوز مصوب نشده. نرخ در Schema بدون مقدار پیش‌فرض است تا کسی نتواند عددی را به‌عنوان واقعیت جا بیندازد.',
        'کارمزد صفر یعنی «قاعده‌ای مطابقت نکرد»، نه «رایگان».',
      ]}
    />
  );
}
