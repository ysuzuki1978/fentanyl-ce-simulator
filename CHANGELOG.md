# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] - 2026-10-25

Cleanup release. Cp and Ce are unchanged: the dose-record engine output (3 weights x 3 models x 2 dose records, Cp, Ce, final state, decrement times, helper functions) is bit-identical to 1.1.0, and so are the analgesia bands, thresholds and probabilities. The engine was already index-based RK4; against the matrix-exponential solution it agrees to better than 1e-6 relative (checked for 27 cases).

### Fixed
- The elapsed-time display (live run and snapshot labels) floored a sum of 0.02 min steps without tolerance. Ten steps give 0.19999999999999998 min, which showed as 11 s instead of 12 s, and a full minute showed as 00:59 for the second that followed. The floor now has a 1e-6 s tolerance (`elapsedWholeSeconds`)

### Changed
- `js/clock.js` (new): `formatClockTime`, `parseClock`, `clockTimeAfter`, `minutesIntoCase`. They replace five `toLocaleTimeString('en-GB', {hour12:false})` calls, three hand-written HH:MM paddings in the Now buttons, and the Date / `setHours` / wrap-at-1440 arithmetic that was written twice (dose time, assessment time). Old and new formatting agree on 90,024 sampled instants; the headless Chrome dose / assessment / CSV run (start 22:40, doses across midnight) is identical to 1.1.0
- Two behaviours of the clock code that cannot be reached from the page but were wrong in principle: a time typed as the start's own HH:MM is minute 0 whatever seconds the start carries (it was minute 1439 when the start had seconds), and midnight is always `00:00` (some engines print `24:00` with `hour12: false`)
- `Patient.minutesToClockTime` and `Patient.clockTimeToMinutes` were removed (no remaining caller)
- `js/analgesia.js`: the MEC / MEAC medians, the MAC-reduction point and the skin-incision values are named constants, used by the curves, the bands, the range labels and the decrement thresholds. The 1440 min limit on an assessment time comes from `ValidationLimits.Dosing.maximumTime`
- `emptyState()` replaces the zero state literal written in eight places
- `npm test` also runs `test/` (Node `--test`, no dependencies)

### Removed
- `IndividualMEAC.densityOnConcentrationAxis`, `RealtimeEngine.getDecrementTimes`, `ChartView.tickFormatter`, the `SystemState` class and `RealtimeSnapshot.recordedAt`: no caller in `js/`, `index.html` or `validation/`

### Added
- `test/`: 60 tests. Cp and Ce against the exact solution (27 cases), the real-time engine against the exact solution, parameter regression, clock, shared constants, and five negative controls

### Not done
- ES modules: the scripts are classic scripts that publish globals and also export for Node. `js/main.js` (1,640 lines) reads those globals directly, so converting needs a pass over all eight files at once
- `js/chart-view.js` duplicates the chart zoom code of the other apps
- DST: a case that spans a clock change is converted by elapsed real time

## [1.1.0] - 2026-10-23

See README.md, version history.
