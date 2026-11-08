`pre-rollover.json` is a real 49-event time-skipping Temporal history captured
and replayed before the task 1214 rollover change, from workflow code at
`c23c3e3c` (unchanged in `5c2fab4a`). SDK 1.23.0, captured 2026-11-02.
All domain identifiers and activity results are synthetic. It reaches FUNDS_HELD,
records one overdue reminder and arms the next deadline. The replay test feeds
this fixed history to the new workflow implementation; it cannot regenerate the
fixture from the code under test. Rolled-over histories are captured and replayed
by the rollover behavior tests as well.
