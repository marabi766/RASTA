import type { ReactNode } from 'react';
import { UnderConstruction } from '@/components/under-construction';

/** Generated from the capability manifest entry `returns`. Reads nothing, calls nothing. */
export default function Page(): ReactNode {
  return (
    <UnderConstruction
      capabilityKey="returns"
      value={[
        'مرجوعی و ضمانت امروز هیچ مسیری در پلتفرم ندارند و خارج از سامانه پیگیری می‌شوند.',
        'بدون لجستیک معکوس، تسویهٔ مالی یک سفارش مرجوعی مبهم می‌ماند.',
      ]}
      prerequisites={[
        'ADR-048 مرز را ثبت کرده اما تصمیم محصولی دربارهٔ اینکه هزینهٔ حمل برگشت بر عهدهٔ کیست، هنوز گرفته نشده.',
      ]}
    />
  );
}
