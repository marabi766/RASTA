import type { ReactNode } from 'react';
import { UnderConstruction } from '@/components/under-construction';

/** Generated from the capability manifest entry `inventory`. Reads nothing, calls nothing. */
export default function Page(): ReactNode {
  return (
    <UnderConstruction
      capabilityKey="inventory"
      value={[
        'امروز عدد اعلامی تأمین‌کننده تنها نشانهٔ موجودی است و هیچ رزروی پشت آن نیست.',
        'بدون انبار، مسیر قطعه از خرید تا نصب روی ماشین قابل ردیابی نیست.',
      ]}
      prerequisites={[
        'تصمیم دربارهٔ اینکه انبار متعلق به سازمان است یا به پلتفرم.',
        'مدل رزرو: رزرو نرم هنگام ثبت سفارش یا رزرو سخت هنگام تأیید تأمین‌کننده.',
      ]}
    />
  );
}
