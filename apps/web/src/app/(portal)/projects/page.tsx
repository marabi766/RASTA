import type { ReactNode } from 'react';
import { UnderConstruction } from '@/components/under-construction';

/** Generated from the capability manifest entry `construction`. Reads nothing, calls nothing. */
export default function Page(): ReactNode {
  return (
    <UnderConstruction
      capabilityKey="construction"
      value={[
        'پروژهٔ عمرانی امروز در فایل و جدول جداگانه مدیریت می‌شود و به ناوگان و قرارداد وصل نیست.',
        'گردش موافقت — چه کسی، در چه سطحی، تا چه سقفی تأیید می‌کند — از پیکربندی می‌آید، نه از کد.',
        'مناقصهٔ منتشرشده باید عمومی و قابل استناد باشد؛ همین، دلیل انتخاب رندر سمت سرور بود.',
      ]}
      prerequisites={[
        'مراجع موافقت و سطوح اختیار باید به‌صورت پیکربندی مصوب تعریف شوند؛ پلتفرم مرجع حقوقی جدید نمی‌سازد.',
        'مدل ارزیابی پیشنهاد باید صریح باشد تا رتبه‌بندی، قابل توضیح و قابل اعتراض بماند.',
      ]}
    />
  );
}
