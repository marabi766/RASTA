import type { ReactNode } from 'react';
import { UnderConstruction } from '@/components/under-construction';

/** Generated from the capability manifest entry `procurement`. Reads nothing, calls nothing. */
export default function Page(): ReactNode {
  return (
    <UnderConstruction
      capabilityKey="procurement"
      value={[
        'یک دهیاری به‌تنهایی حجم خرید کافی برای گرفتن قیمت خوب ندارد؛ تجمیع تقاضای چند سازمان، همان حجم را می‌سازد.',
        'استعلام بها امروز خارج از پلتفرم و بدون سابقهٔ قابل ممیزی انجام می‌شود.',
        'سفارش خرید بدون پیوند به نیاز ثبت‌شده، مسیر حسابرسی ندارد.',
      ]}
      prerequisites={[
        'قواعد تجمیع — چه کسی تجمیع را آغاز می‌کند و سهم هر سازمان چگونه تعیین می‌شود — یک تصمیم حاکمیتی است، نه فنی.',
        'مرز میان استعلام و مناقصه باید روشن شود تا دو سازوکار موازی ساخته نشود.',
      ]}
    />
  );
}
