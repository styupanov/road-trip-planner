import { FinalizedDay, FinalizedLodging, FinalizedStop } from './api';

// Google Maps' consumer "directions" deep link (api=1) supports at most 10
// points total: origin + waypoints + destination. 8 leaves room for both ends.
const MAX_WAYPOINTS = 8;

interface MapPoint {
  lat: number;
  lon: number;
  place_id?: string;
}

const encodePoint = (p: MapPoint): string => `${p.lat},${p.lon}`;

/**
 * Builds a Google Maps directions deep link for ONE finalized day — origin
 * -> this day's attractions (in route order) -> destination, driving. No
 * API key needed (this is a deep link, not the Directions API); the caller
 * only needs to render it as a plain <a href>.
 *
 * Day-boundary rules (not simply "first/last stop of the day"):
 * - Day 1's origin is the trip's own start (tripStart). Every later day's
 *   origin is the PREVIOUS day's chosen lodging (prevDayLodging) if one was
 *   picked; if it was skipped, origin falls back to this day's own first
 *   attraction, which is then removed from the waypoint list — it's now
 *   the origin, not a stop along the way.
 * - This day's destination is its own chosen lodging (day.lodging) if
 *   present, or (no lodging) its last attraction, removed from waypoints
 *   for the same reason.
 *
 * place_id params (origin_place_id/destination_place_id/waypoint_place_ids)
 * are added ONLY when every single point in this link has one — lodging
 * always does, a FinalizedStop never does (stops come from the local POI
 * database, not Google Places, see poi.py), so in practice any day with at
 * least one attraction omits them entirely and falls back to coordinates
 * only, which the main params always carry regardless.
 *
 * Returns null when there aren't at least two distinct real points to
 * route between — a day with no attractions and no lodging at either end
 * (day_split.py guarantees every day has >=1 stop unless the WHOLE trip
 * has zero, an extreme edge case; a pure function shouldn't assume that
 * invariant holds forever, so it's handled here instead of assumed away).
 *
 * dayStops must already be resolved (day.stop_indices mapped against
 * trip.stops, e.g. same as FinalizedView's own dayStops) and in the SAME
 * route order they're rendered in — this function never re-sorts them.
 */
export function buildGoogleMapsDayUrl(
  day: FinalizedDay,
  dayStops: FinalizedStop[],
  prevDayLodging: FinalizedLodging | null,
  tripStart: { lat: number; lon: number },
): string | null {
  // Converted to MapPoint up front — a FinalizedStop never carries a
  // place_id (see the function docstring), so this keeps that "undefined"
  // explicit and well-typed instead of leaking the FinalizedStop shape into
  // the place_id-uniformity check below.
  const remaining: MapPoint[] = dayStops.map((s) => ({ lat: s.lat, lon: s.lon }));

  let origin: MapPoint;
  if (day.day === 1) {
    origin = { lat: tripStart.lat, lon: tripStart.lon };
  } else if (prevDayLodging) {
    origin = { lat: prevDayLodging.lat, lon: prevDayLodging.lon, place_id: prevDayLodging.place_id };
  } else if (remaining.length > 0) {
    const first = remaining.shift()!;
    origin = { lat: first.lat, lon: first.lon };
  } else {
    return null; // no lodging behind us, no attractions today -> nothing to start from
  }

  let destination: MapPoint;
  if (day.lodging) {
    destination = { lat: day.lodging.lat, lon: day.lodging.lon, place_id: day.lodging.place_id };
  } else if (remaining.length > 0) {
    const last = remaining.pop()!;
    destination = { lat: last.lat, lon: last.lon };
  } else {
    return null; // origin already consumed the only attraction — nothing left to end on
  }

  let waypoints = remaining;
  if (waypoints.length > MAX_WAYPOINTS) {
    console.warn(
      `buildGoogleMapsDayUrl: day ${day.day} has ${waypoints.length} waypoints, ` +
      `Google Maps deep links support at most ${MAX_WAYPOINTS} — truncating to the first ${MAX_WAYPOINTS} in route order.`
    );
    waypoints = waypoints.slice(0, MAX_WAYPOINTS);
  }

  const params = new URLSearchParams();
  params.set('api', '1');
  params.set('origin', encodePoint(origin));
  params.set('destination', encodePoint(destination));
  if (waypoints.length > 0) {
    params.set('waypoints', waypoints.map(encodePoint).join('|'));
  }
  params.set('travelmode', 'driving');

  const allPoints = [origin, ...waypoints, destination];
  if (allPoints.every((p) => p.place_id)) {
    params.set('origin_place_id', origin.place_id!);
    params.set('destination_place_id', destination.place_id!);
    if (waypoints.length > 0) {
      params.set('waypoint_place_ids', waypoints.map((p) => p.place_id!).join('|'));
    }
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
