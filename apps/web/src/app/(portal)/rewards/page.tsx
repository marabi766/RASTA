import type { ReactNode } from 'react';
import { UnderConstruction } from '@/components/under-construction';

/** Generated from the capability manifest entry `rewards`. Reads nothing, calls nothing. */
export default function Page(): ReactNode {
  return (
    <UnderConstruction
      capabilityKey="rewards"
      value={[
        'ثبت به‌موقع و کامل داده، همان چیزی است که کل پلتفرم به آن وابسته است؛ امتیاز مشارکت برای تشویق همان است.',
      ]}
      prerequisites={[
        'Q-09 — چه سهمی از کارمزد، پاداش را تأمین می‌کند — باز است، بنابراین قواعد فعلی فقط امتیازی‌اند و هیچ ثبت مالی نمی‌سازند.',
        'Q-13 — نردبان سطح — باز است، بنابراین سطح کاربر برابر null است و «سطح صفر» نمایش داده نمی‌شود.',
      ]}
    />
  );
}
