// Fixed day-split palette, in order — day 1 first. Single source of truth for
// both the map (route segments, day-boundary markers, legend) and PlanPanel
// (day group headers), so they never drift apart. Deliberately excludes
// #e8b53f (stop markers) and the origin/destination marker colors (#4a90d9,
// #b968c7) — those are reserved and must stay visually distinct from any day.
const DAY_COLORS = [
  '#1d9e9e', // День 1 — бирюза
  '#7f77dd', // День 2 — фиолет
  '#e07b39', // День 3 — оранж
  '#639922', // День 4 — зелень
  '#c0563f', // День 5 — терракота
  '#4a7fb5', // День 6 — стальной синий
  '#9e7b1d', // День 7 — охра
];

// dayIndex is 0-based (day.day - 1). Cycles past 7 days rather than repeating
// a color adjacent to itself in sequence — acceptable at that trip length.
export function dayColor(dayIndex: number): string {
  return DAY_COLORS[dayIndex % DAY_COLORS.length];
}
