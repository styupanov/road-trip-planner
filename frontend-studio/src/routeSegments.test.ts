// Not wired into a test runner — this project has none configured (see
// CLAUDE.md). Uses Node's built-in assert instead of adding a new
// dependency just for one file. Run directly: npx tsx src/routeSegments.test.ts
import assert from 'node:assert/strict';
import { nearestPointIndices, pivotDayIndex } from './routeSegments';

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`PASS: ${label}`);
}

// --- Bug 1 regression: a route revisiting the same physical area twice ---
// (round-trip loop) must match a waypoint to the FIRST (nearby) approach it
// passes, not a later, numerically closer coincidental revisit — this is
// the exact mechanism behind the real "day 2 stretches into day 3" bug
// (Salida, CO sitting on the corridor both toward and, coincidentally,
// near again on the way back toward Leadville).
check('nearestPointIndices: picks the FIRST (nearby) approach, not a later closer revisit', () => {
  const target = { lat: 0, lng: 0 };
  const path: { lat: number; lng: number }[] = [];
  for (let i = 0; i <= 400; i++) {
    let lat: number;
    if (i <= 50) {
      lat = 1.0 - (i / 50) * 0.99; // 1.0 -> 0.01: first approach, CLOSE but not exact
    } else if (i <= 100) {
      lat = 0.01 + ((i - 50) / 50) * 0.99; // 0.01 -> 1.0: moving away
    } else if (i <= 300) {
      lat = 1.0 + ((i - 100) / 200) * 4.0; // 1.0 -> 5.0: far side of the loop
    } else if (i <= 325) {
      lat = 5.0 - ((i - 300) / 25) * 5.0; // 5.0 -> 0.0: second approach, EXACT hit
    } else {
      lat = ((i - 325) / 75) * 1.0; // 0.0 -> 1.0: moving away again
    }
    path.push({ lat, lng: 0 });
  }

  const [idx] = nearestPointIndices(path, [target]);
  assert.equal(idx, 50, `expected the first (i=50, d=0.01) approach, got i=${idx}`);
});

// --- Bug 1: waypoints must stay in the order they were given ---
check('nearestPointIndices: indices are non-decreasing across a normal multi-waypoint route', () => {
  // Long relative to the waypoint spacing on purpose — a short path here
  // would make the waypoint-to-waypoint gap look "implausibly large" as a
  // FRACTION of the whole path and spuriously exercise the monotonicity
  // fallback (harmless, but not what this test is checking), the same way
  // a real multi-day trip's route.shape (tens of thousands of points) never
  // comes close to that fraction for a normal day-to-day hop.
  const path: { lat: number; lng: number }[] = [];
  for (let i = 0; i <= 2000; i++) path.push({ lat: i * 0.01, lng: 0 });

  const waypoints = [
    { lat: 0.2, lng: 0 },   // ~i=20
    { lat: 0.9, lng: 0 },   // ~i=90
    { lat: 1.5, lng: 0 },   // ~i=150
  ];
  const indices = nearestPointIndices(path, waypoints);

  for (let i = 1; i < indices.length; i++) {
    assert.ok(indices[i] >= indices[i - 1], `index ${i} (${indices[i]}) is not >= previous (${indices[i - 1]})`);
  }
});

// --- Bug 1: a waypoint legitimately off the road (~200-300m) must still be found ---
check('nearestPointIndices: finds a waypoint offset ~300m from the road, not just an exact hit', () => {
  const path: { lat: number; lng: number }[] = [];
  for (let i = 0; i <= 100; i++) path.push({ lat: i * 0.01, lng: 0 });

  // ~0.003 deg longitude at these latitudes is roughly 300m -- a real
  // building/parking lot set back from the highway, never distance 0.
  const target = { lat: 0.5, lng: 0.003 };
  const [idx] = nearestPointIndices(path, [target]);
  assert.equal(idx, 50);
});

// --- Bug 2 (routeSegments.ts): the closing leg of a round trip is often the
// longest uninterrupted stretch of the whole route — a jump consuming well
// over MONOTONIC_JUMP_WARN_FRACTION (0.3) of the path is expected and
// CORRECT for the LAST waypoint, and must not be second-guessed into a
// bounded fallback that can never reach it. Confirmed on real production
// data (a 135321-point round-trip polyline): the primary search already
// finds the true final point correctly on its own; only the "implausible
// jump" validator was wrongly overriding that correct answer.
//
// Geometry here is built so segment B is an IMPROVEMENT over segment A
// (never a hysteresis-triggering regression) and segment C is a single
// smooth, monotonic approach all the way to an exact hit at the path's
// last point — this isolates the validator's behavior, not the primary
// search's (already covered by the "first approach" test above).
check('nearestPointIndices: a legitimately large final jump (>30% of the path) matches the true end, not a fallback stub', () => {
  const path: { lat: number; lng: number }[] = [];

  // Segment A: waypoint 1's own region, far from waypoint 2's target (0) —
  // so the search for waypoint 2 doesn't start out deceptively close to 0.
  for (let i = 0; i <= 100; i++) path.push({ lat: 1000 + i * 0.01, lng: 0 }); // 1000.0 -> 1000.5

  // Segment B: a long, flat "middle of the trip" stretch far from both
  // targets. Arriving here from segment A is a big IMPROVEMENT in distance
  // to waypoint 2's target, never a regression, so hysteresis never fires.
  for (let i = 1; i <= 8900; i++) path.push({ lat: 500, lng: 0 });

  // Segment C: the genuine final approach — smoothly, monotonically closing
  // the distance to origin (target 0) over the last 100 points, exact hit
  // at the path's very last point.
  for (let i = 1; i <= 100; i++) path.push({ lat: 500 * (1 - i / 100), lng: 0 });

  const waypoints = [
    { lat: 1000.2, lng: 0 }, // waypoint 1, matches within segment A
    { lat: 0, lng: 0 },      // closing waypoint -- true match is the path's LAST point
  ];
  const indices = nearestPointIndices(path, waypoints);

  const jumpFraction = (indices[1] - indices[0]) / path.length;
  assert.ok(jumpFraction > 0.3, `test setup check: expected a >30% jump, got ${(jumpFraction * 100).toFixed(1)}%`);
  assert.equal(
    indices[1], path.length - 1,
    `expected the closing waypoint to match the path's true end, got ${indices[1]} (path.length=${path.length})`
  );
});

// --- Bug 2: round-trip pivot hop attribution ---
check('pivotDayIndex: mid-day crossing (day already has a stop) stays on the current day', () => {
  assert.equal(pivotDayIndex(1, true), 1);
});

check('pivotDayIndex: clean day-boundary crossing defers to the PREVIOUS day', () => {
  // day 3 (index 2) contributed nothing before the crossing -> day 2
  // (index 1) is the one that actually closed leg1 out.
  assert.equal(pivotDayIndex(2, false), 1);
});

check('pivotDayIndex: l1===0 edge case, day 1 (index 0) always owns it', () => {
  assert.equal(pivotDayIndex(0, false), 0);
});

console.log(`\nAll ${passed} routeSegments tests passed.`);
