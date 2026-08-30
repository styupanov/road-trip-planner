// Not wired into a test runner — this project has none configured (see
// CLAUDE.md). Uses Node's built-in assert instead of adding a new
// dependency just for one file. Run directly: npx tsx src/dayAttribution.test.ts
import assert from 'node:assert/strict';
import { attributeCandidateToDay, DaySplitDay } from './dayAttribution';

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`PASS: ${label}`);
}

// Two days: day 1 = stops at to_poi_s [1000, 2000], day 2 = stops at
// to_poi_s [3000, 4000] — indices 0-1 and 2-3 respectively.
const includedStops = [
  { to_poi_s: 1000 },
  { to_poi_s: 2000 },
  { to_poi_s: 3000 },
  { to_poi_s: 4000 },
];
const days: DaySplitDay[] = [
  { day: 1, stop_indices: [0, 1] },
  { day: 2, stop_indices: [2, 3] },
];

check('candidate in the middle of a day -> that day', () => {
  // Closest to index 1 (to_poi_s 2000, day 1) than to index 2 (3000, day 2).
  const day = attributeCandidateToDay({ to_poi_s: 1900 }, days, includedStops);
  assert.equal(day, 1);
});

check('candidate exactly on the boundary between two days -> earlier day wins the tie', () => {
  // Midpoint between day 1's last stop (2000) and day 2's first stop (3000)
  // is 2500 -- equidistant from both, strict-less-than means the first
  // (earlier) match found while walking days in order keeps the win.
  const day = attributeCandidateToDay({ to_poi_s: 2500 }, days, includedStops);
  assert.equal(day, 1);
});

check('candidate closer to day 2 side of the boundary -> day 2', () => {
  const day = attributeCandidateToDay({ to_poi_s: 2600 }, days, includedStops);
  assert.equal(day, 2);
});

check('candidate before the first stop entirely -> day 1', () => {
  const day = attributeCandidateToDay({ to_poi_s: 0 }, days, includedStops);
  assert.equal(day, 1);
});

check('candidate after the last stop entirely -> last day', () => {
  const day = attributeCandidateToDay({ to_poi_s: 9999 }, days, includedStops);
  assert.equal(day, 2);
});

check('empty days (draft before its first split) -> null, show unfiltered', () => {
  const day = attributeCandidateToDay({ to_poi_s: 2500 }, [], includedStops);
  assert.equal(day, null);
});

check('every day stop-less (degenerate no-stops trip) -> null', () => {
  const noStopDays: DaySplitDay[] = [{ day: 1, stop_indices: [] }];
  const day = attributeCandidateToDay({ to_poi_s: 2500 }, noStopDays, includedStops);
  assert.equal(day, null);
});

check('exact hit on a stop\'s own to_poi_s -> that stop\'s day', () => {
  const day = attributeCandidateToDay({ to_poi_s: 3000 }, days, includedStops);
  assert.equal(day, 2);
});

console.log(`\nAll ${passed} dayAttribution tests passed.`);
