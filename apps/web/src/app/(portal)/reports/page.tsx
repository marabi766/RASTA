import type { ReactNode } from 'react';
import { UnderConstruction } from '@/components/under-construction';

/** Generated from the capability manifest entry `analytics`. Reads nothing, calls nothing. */
export default function Page(): ReactNode {
  return (
    <UnderConstruction
      capabilityKey="analytics"
      value={[
        'داشبورد امروز فقط وضعیت ساخت را گزارش می‌کند، چون هیچ سرویسی شاخص عملیاتی محاسبه نمی‌کند.',
        'گزارش تجمیعی استانداری باید فقط تجمیعی باشد و به تراکنش فردی دسترسی ندهد.',
      ]}
      prerequisites={[
        'شاخص‌های وابسته به خط مبنا تا پر نشدن خط مبنا نمایش داده نمی‌شوند — نه صفر، نه عدد ساختگی.',
        'مدل خواندنی باید از رویدادهای موجود ساخته شود، نه با Join میان‌سرویسی.',
      ]}
    />
  );
}
