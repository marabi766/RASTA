import type { ReactNode } from 'react';
import { UnderConstruction } from '@/components/under-construction';

/** Generated from the capability manifest entry `audit`. Reads nothing, calls nothing. */
export default function Page(): ReactNode {
  return (
    <UnderConstruction
      capabilityKey="audit"
      value={[
        'هر تغییر وضعیت امروز رویداد تولید می‌کند، اما جای الحاقی و غیرقابل تغییری برای نگهداری آن‌ها ساخته نشده.',
        'ممیزی مستقل بدون سابقهٔ تغییرناپذیر، ادعای قابل اثبات نیست.',
      ]}
      prerequisites={[
        'ADR-053 مرز شواهد فقط‌الحاقی را ثبت کرده است؛ پیاده‌سازی هنوز شروع نشده.',
        'مدت نگهداری و سیاست دسترسی به سابقه، تصمیم حاکمیتی می‌خواهد.',
      ]}
    />
  );
}
