// Splits ONE combined route polyline (all Google Directions hands back is a
// single flat point list — no per-leg geometry) into per-leg point arrays, by
// nearest-point matching each waypoint onto the path in order.

// === Bug 1: local minimum with hysteresis, not global minimum ===
// A naive "closest point anywhere in the remaining path" search breaks on a
// round-trip loop: the route can pass NEAR the same physical location
// twice. Confirmed on real production data — Salida, CO sits on the
// corridor toward Leadville, so the path comes within ~2.2km of a Salida
// hotel right after the correct nearby stop (Monarch Mountain), then
// coincidentally comes within ~43m of the SAME coordinates ~45,000 points
// later, near the loop's far turnaround point (Leadville). A pure global
// minimum search grabs that far, numerically-closer point instead of the
// correct nearby one, swallowing the entire distance between them (~750km)
// into one wildly oversized "segment", colored as if it were a short local
// hop between two adjacent stops.
//
// Fix: walk forward from searchFrom, track the running minimum distance,
// and commit to it as soon as the path has CLEARLY moved on — d² has grown
// past LOCAL_MIN_HYSTERESIS_RATIO times the running minimum for at least
// LOCAL_MIN_CONFIRM_POINTS consecutive points. This is "the first local
// minimum encountered while moving forward", not "the closest point
// anywhere ahead" — a coincidental later revisit of similar coordinates is
// never even considered, because the search has already committed and
// stopped well before reaching it.
//
// No absolute distance/degree threshold on purpose: coordinates are in
// degrees (nonlinear with latitude), and a real waypoint can legitimately
// sit 200-300m off the actual road (parking lot, building set back from the
// highway) — a fixed cutoff would either falsely reject that or be too
// loose to reject a genuine early false minimum from polyline noise. Ratio
// + sustained-point-count hysteresis has neither problem: it only compares
// d² to ITS OWN running minimum, never to an absolute unit.
const LOCAL_MIN_HYSTERESIS_RATIO = 2.0;
// ~20 polyline points is comfortably past typical geometry noise — the real
// production trip above averaged ~26m/point, so this is a ~500m "clearly
// moved on" margin, well past the 200-300m off-road tolerance mentioned
// above (a legitimately-offset waypoint's true local minimum still gets
// found and confirmed before hysteresis would reject it).
const LOCAL_MIN_CONFIRM_POINTS = 20;

// === Bug 1 safety net: monotonicity validation + bounded fallback ===
// Waypoint indices on `path` MUST be non-decreasing — the backend built
// Directions strictly through the waypoints in order, so the real polyline
// visits them in that same order (two waypoints CAN legitimately match the
// SAME index, e.g. a stop and its lodging sitting at ~identical
// coordinates — confirmed in production data — so equal is fine, only a
// DECREASE is a violation). If the local-minimum search above still
// produces a non-monotonic result (or an implausibly large forward jump)
// for some reason, that itself is a sign the match is wrong. Falling back
// to the ORIGINAL (buggy) unbounded global search would just risk
// repeating a far-revisit mistake, so the fallback re-searches within a
// bounded window instead — never the whole remaining path.
// A single hop consuming more than this fraction of the ENTIRE polyline is
// implausible for any real multi-waypoint trip.
const MONOTONIC_JUMP_WARN_FRACTION = 0.3;
// Bounded re-search window for the fallback (points) — generous enough to
// still find a genuinely distant next waypoint, small enough to make a
// coincidental far revisit of similar coordinates very unlikely to win.
const MONOTONIC_FALLBACK_WINDOW_POINTS = 5000;

function squaredDist(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const dLat = a.lat - b.lat;
  const dLng = a.lng - b.lng;
  return dLat * dLat + dLng * dLng;
}

// Scans path[from..to) for wp's first LOCAL minimum distance while moving
// forward (see module comment above) — never the global minimum across the
// whole range. `to` defaults to path.length (unbounded end, used by the
// primary search below); the monotonicity fallback passes a bounded `to`
// instead.
function findLocalMinimumIndex(
  path: { lat: number; lng: number }[],
  wp: { lat: number; lng: number },
  from: number,
  to: number = path.length
): number {
  let bestIdx = from;
  let bestDist = Infinity;
  let growthStreak = 0;

  for (let i = from; i < to; i++) {
    const d = squaredDist(path[i], wp);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
      growthStreak = 0;
    } else if (d > bestDist * LOCAL_MIN_HYSTERESIS_RATIO) {
      growthStreak++;
      if (growthStreak >= LOCAL_MIN_CONFIRM_POINTS) {
        return bestIdx; // confirmed -- the path has clearly moved on, stop here
      }
    }
    // else: within the hysteresis band but not a new best -- noise, keep
    // scanning without resetting OR counting it toward the streak.
  }

  return bestIdx; // reached `to` without a confirmed departure -- best found so far
}

// Exported for testability (see routeSegments.test.ts) — not meant to be
// called directly outside this module otherwise, splitPathIntoLegs below is
// the real entry point.
export function nearestPointIndices(
  path: { lat: number; lng: number }[],
  waypoints: { lat: number; lng: number }[]
): number[] {
  const indices: number[] = [];
  let searchFrom = 0;

  for (const wp of waypoints) {
    const idx = findLocalMinimumIndex(path, wp, searchFrom);
    indices.push(idx);
    searchFrom = idx;
  }

  // Monotonicity validator: a local-minimum match can still land at or
  // before the previous waypoint's index (or jump implausibly far) if the
  // route geometry is unusual enough to fool the hysteresis window too —
  // re-resolve just that one waypoint within a bounded window instead of
  // trusting an unbounded re-search (see module comment above).
  for (let i = 1; i < indices.length; i++) {
    const jump = indices[i] - indices[i - 1];
    const isNonMonotonic = jump < 0;
    const isImplausibleJump = jump > path.length * MONOTONIC_JUMP_WARN_FRACTION;
    if (isNonMonotonic || isImplausibleJump) {
      const windowEnd = Math.min(path.length, indices[i - 1] + MONOTONIC_FALLBACK_WINDOW_POINTS);
      const fallbackIdx = findLocalMinimumIndex(path, waypoints[i], indices[i - 1], windowEnd);
      console.warn(
        `nearestPointIndices: waypoint ${i} matched ${isNonMonotonic ? 'non-monotonically' : 'with an implausibly large jump'} ` +
        `(prev=${indices[i - 1]}, got=${indices[i]}) — falling back to a bounded search, result=${fallbackIdx}`
      );
      indices[i] = fallbackIdx;
    }
  }

  return indices;
}

// `waypoints` is the full stop sequence including origin and destination
// (length = legCount + 1) — same order as the stops array sent to
// /detail-route, which is the same order day_split.py's stop_indices index
// into. Returns one point array per leg (waypoints.length - 1 of them);
// segment i and i+1 share their boundary point so adjacent colors touch with
// no visual gap.
export function splitPathIntoLegs(
  path: { lat: number; lng: number }[],
  waypoints: { lat: number; lng: number }[]
): { lat: number; lng: number }[][] {
  if (path.length === 0 || waypoints.length < 2) return [];

  const indices = nearestPointIndices(path, waypoints);
  const segments: { lat: number; lng: number }[][] = [];
  for (let i = 0; i < indices.length - 1; i++) {
    segments.push(path.slice(indices[i], indices[i + 1] + 1));
  }
  return segments;
}

// === Bug 2 (independent of the above): round-trip pivot day attribution ===
// The hop "night N's lodging -> pivot X" belongs to day N (finishing that
// day's drive to the turnaround point), not day N+1 — even when day N
// happens to end EXACTLY at the last leg1 stop (a clean day boundary that
// coincides with the leg1/leg2 crossing). Mirrors finalize.py's own "leg1's
// own destination day" convention: the day whose cumulative leg1 stop count
// first reaches its own total is the one that owns the pivot hop, not
// whichever day's loop iteration happens to be running when the crossing
// stop is encountered.
//
// dayHasOwnStop: whether THIS day has already pushed one of its own stops
// before reaching the crossing point, in the same forward walk. true means
// the crossing happened mid-day (already correctly attributed to this day
// — no fix needed there). false means this day contributed nothing before
// the crossing, so the pivot actually closes out the PREVIOUS day instead.
// dayIdx===0 is the one exception (l1===0, the crossing happens before any
// stop at all) — day 1 always owns it, there's no day -1 to defer to.
export function pivotDayIndex(dayIdx: number, dayHasOwnStop: boolean): number {
  return dayIdx > 0 && !dayHasOwnStop ? dayIdx - 1 : dayIdx;
}
