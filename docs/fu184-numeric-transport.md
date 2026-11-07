# FU-184 numeric transport decision

FU-160 (#848) retained exponent text for the four non-integer `numberInput`
fields: asset and organization nearby latitude and longitude. FU-184 retains
that compatibility, including JavaScript serialization of small coordinates,
but refuses every nonzero decimal significand that converts to zero. This
applies equally to exponent notation and long fractional text. Overflow still
fails the inner finite-number validator. A JSON number already rounded by its
JSON parser cannot be recovered here.

All accepted negative zero, whether a JSON number or decimal text, becomes
positive zero before inner validation. Integer text continues to refuse
fractions and exponents. Optional, nullable and default wrappers retain their
existing semantics. Refusals use FU-160 fixed diagnostics without echoing input.

Decimal-string fields remain exact text and refuse surrounding whitespace.
The class sweep covers fleet hours, kilometres, hourMeter and odometer;
maintenance create/update schedule intervalHours, intervalKilometres,
leadHours, leadKilometres, lastServicedHourMeter and lastServicedOdometer;
part quantity and labour hours. All three shared decimal-string constructors
now validate raw text. Postal codes and phone numbers are outside this class.
