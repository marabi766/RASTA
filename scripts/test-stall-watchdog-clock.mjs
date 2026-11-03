/**
 * The one timebase of the stall watchdog: milliseconds on the operating system's
 * MONOTONIC clock (CLOCK_MONOTONIC behind process.hrtime), the same origin in
 * every thread of the process. The main thread stamps it around each test and
 * the watchdog thread subtracts it from its own reading, so a wall-clock
 * correction (NTP step, VM resume, manual change) can neither kill a healthy
 * test nor hide a stalled one (#606 r1 F2). Never use Date.now() for a duration.
 */
export const monotonicMs = () => Number(process.hrtime.bigint()) / 1e6;
