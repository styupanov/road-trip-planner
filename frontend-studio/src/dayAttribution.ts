// Attributes a stop (typically a not-yet-included candidate) to the day it
// falls nearest to, once a day-split exists (Шаг 0 of the trip-editor UI
// migration — see backend's POST /day-split). Not wired into any UI yet;
// this is purely the pure-function foundation for Step 3's candidates panel.

// Matches the shape POST /day-split's response (and day_split.split_into_days
// on the backend) already returns — day.stop_indices are indices into
// includedStops, itself sorted the same way that response's stop_count/
// stop_indices already assume (by to_poi_s, ascending).
export interface DaySplitDay {
  day: number;
  stop_indices: number[];
}

// attributeCandidateToDay(candidate, days, includedStops) -> dayNumber | null
//
// Every ApiStop — included in the route or not — carries `to_poi_s` (its
// position along the route) regardless of whether a day-split has ever run
// on it, so a not-yet-included candidate can be compared against it without
// any new backend data.
//
// Deliberately nearest-neighbor over every included stop with a known day,
// not a "does it fall inside day N's own to_poi_s range" containment check:
// the same one rule naturally handles every case the range check would
// need special-cased separately —
//   - before the very first stop: nearest is day 1's own first stop
//   - after the very last stop: nearest is the last day's own last stop
//   - exactly between two days: nearest is whichever flanking stop is closer
//     (a tie goes to the EARLIER day — days are walked in order and the
//     comparison is strict-less-than, so the first equally-close match wins)
//
// Returns null when there's nothing to attribute against yet: `days` is
// empty (no split has been computed at all — a draft before its first
// preview) or every day in it happens to have zero stops (the degenerate
// whole-trip-has-no-stops case). Callers show every candidate unfiltered in
// that case — there's no day concept yet to filter BY, not a filter that
// happens to exclude everything.
export function attributeCandidateToDay(
  candidate: { to_poi_s: number },
  days: DaySplitDay[],
  includedStops: { to_poi_s: number }[]
): number | null {
  let bestDay: number | null = null;
  let bestDist = Infinity;

  for (const day of days) {
    for (const idx of day.stop_indices) {
      const stop = includedStops[idx];
      if (!stop) continue;
      const dist = Math.abs(stop.to_poi_s - candidate.to_poi_s);
      if (dist < bestDist) {
        bestDist = dist;
        bestDay = day.day;
      }
    }
  }

  return bestDay;
}
