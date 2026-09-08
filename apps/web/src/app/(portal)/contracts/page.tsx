import type { ReactNode } from 'react';
import { UnderConstruction } from '@/components/under-construction';

/** Generated from the capability manifest entry `contracts`. Reads nothing, calls nothing. */
export default function Page(): ReactNode {
  return (
    <UnderConstruction
      capabilityKey="contracts"
      value={[
        'قرارداد و صورت‌وضعیت، پل میان کار انجام‌شده و پرداخت‌اند؛ بدون آن‌ها زنجیره از پروژه تا پول قطع است.',
        'الحاقیه و نقطهٔ عطف باید سابقهٔ تغییر داشته باشند تا اختلاف بعدی قابل داوری باشد.',
      ]}
      prerequisites={[
        'سرویس عمرانی باید نخست وجود داشته باشد؛ قرارداد بدون پروژه، موجودیت بی‌ریشه است.',
      ]}
    />
  );
}
