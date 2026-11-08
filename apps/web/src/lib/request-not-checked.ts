/** Refusal states shared by snapshot-backed forms; none permits dispatch. */
export const REQUEST_NOT_CHECKED = {
  STORE_UNAVAILABLE:
    'امکان بررسی درخواست‌ها اکنون نیست. چیزی ارسال نشد؛ پس از بازیابی دسترسی، دوباره بررسی کنید.',
  CAPACITY:
    'تعداد درخواست‌های حل‌نشده به حد مجاز رسیده است. چیزی ارسال نشد؛ ابتدا درخواست‌های پیشین را بررسی کنید.',
  SNAPSHOT_TOO_LARGE:
    'اطلاعات فرم برای نگهداری امن بیش از حد طولانی است. چیزی ارسال نشد؛ اطلاعات را کوتاه کنید.',
  FORMER_COPY:
    'درخواست پیشین با نسخهٔ قدیمی اطلاعات سازمان نگهداری شده است؛ نتیجهٔ آن را پیش از رها کردن بررسی کنید.',
  SNAPSHOT_UNREADABLE:
    'اطلاعات فرم درخواست پیشین خواندنی نیست؛ نتیجهٔ درخواست را پیش از رها کردن بررسی کنید.',
  CORRUPT_RECORD:
    'رکورد درخواست پیشین معتبر نیست. ارسال و رها کردن آن ممکن نیست؛ برای بررسی با پشتیبانی تماس بگیرید.',
} as const;
export type RequestNotChecked = {
  readonly kind: 'NOT_CHECKED';
  readonly reason: keyof typeof REQUEST_NOT_CHECKED;
  readonly releaseToken?: string;
};
