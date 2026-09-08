import type { ReactNode } from 'react';
import { UnderConstruction } from '@/components/under-construction';

/** Generated from the capability manifest entry `notifications`. Reads nothing, calls nothing. */
export default function Page(): ReactNode {
  return (
    <UnderConstruction
      capabilityKey="notifications"
      value={[
        'امروز هیچ اعلانی تحویل نمی‌شود. یادآوری مهلت سفارش فقط یک ردیف در تاریخچه می‌نویسد و به کسی چیزی نمی‌رساند.',
        'کاربر میدانی با اینترنت ضعیف، به اعلان قابل اتکا و ترجیح کانال نیاز دارد.',
      ]}
      prerequisites={[
        'انتخاب کانال‌ها و ارائه‌دهندهٔ پیامک، تصمیمی است با اثر هزینه‌ای و حقوقی.',
        'قالب‌های فارسی باید پیش از ارسال نخستین پیام، بازبینی و تصویب شوند.',
      ]}
    />
  );
}
