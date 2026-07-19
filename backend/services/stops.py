import asyncio
import math
from typing import Literal

import httpx
import polyline as polyline_lib

import detour
import poi
import routing

_MAX_WKT_POINTS = 500

# One suggested stop per N seconds of baseline drive time, by trip pace.
_PACE_INTERVAL_S = {
    "relaxed": 5400,
    "balanced": 3600,
    "packed": 2400,
}


def _thin_points(points: list[tuple[float, float]], max_points: int = _MAX_WKT_POINTS) -> list[tuple[float, float]]:
    """Прореживает точки маршрута, сохраняя первую и последнюю."""
    if len(points) <= max_points:
        return points

    step = math.ceil(len(points) / max_points)
    thinned = points[::step]
    if thinned[-1] != points[-1]:
        thinned.append(points[-1])
    return thinned


def _to_linestring_wkt(points: list[tuple[float, float]]) -> str:
    coords = ", ".join(f"{lon} {lat}" for lat, lon in points)
    return f"LINESTRING({coords})"


def _resolve_min_endpoint_distance_s(min_endpoint_distance_s: int | None, baseline_s: int) -> int:
    """Filters out POIs too close to origin/destination to be a stop along the way —
    a POI 7 seconds from the finish isn't a detour, it's the destination itself.
    Scales with route length: 5 minutes flat felt right on a 104-minute Gunnison ->
    Montrose run but was meaningless on an 8.5-hour Denver -> Durango one, where it
    let Denver's own downtown landmarks through as "stops". 10% of baseline is a
    heuristic, not a measured constant — needs calibration against real routes.
    An explicit min_endpoint_distance_s always overrides this calculation."""
    if min_endpoint_distance_s is not None:
        return min_endpoint_distance_s
    return max(300, round(baseline_s * 0.1))


def _mark_suggested(stops: list[dict], baseline_s: int, pace: str) -> None:
    """Marks one stop per segment as suggested=True, mutating stops in place.

    The to_poi_s range is split into N equal segments (N = target stop count for
    the given pace); within each non-empty segment, the highest-review_count stop
    is picked. Stops cluster near the route's ends, so segmenting by position
    (not just picking the top-N by review_count overall) spreads suggestions out
    along the whole trip. An empty segment is skipped, not backfilled from a
    neighbor — that would defeat the point of spacing them out.
    """
    for stop in stops:
        stop["suggested"] = False

    if not stops:
        return

    interval_s = _PACE_INTERVAL_S[pace]
    n_segments = max(1, math.floor(baseline_s / interval_s))

    min_t = min(s["to_poi_s"] for s in stops)
    max_t = max(s["to_poi_s"] for s in stops)
    span = max_t - min_t

    segments: list[list[dict]] = [[] for _ in range(n_segments)]
    for stop in stops:
        if span == 0:
            idx = 0
        else:
            idx = min(int((stop["to_poi_s"] - min_t) / span * n_segments), n_segments - 1)
        segments[idx].append(stop)

    for segment in segments:
        if not segment:
            continue
        best = max(segment, key=lambda s: s["review_count"] or 0)
        best["suggested"] = True


async def _find_stops_for_route(
    route_shape: str,
    baseline_s: int,
    origin: tuple[float, float],
    destination: tuple[float, float],
    categories: list[str],
    max_detour_s: int,
    pace: str,
    radius_m: int,
    limit: int,
    min_review_count: int,
    min_endpoint_distance_s: int | None,
) -> dict:
    """Оркестрирует poi.py и detour.py для УЖЕ ГОТОВОГО маршрута (shape + duration),
    не вызывая routing заново — так compare_routes может посчитать остановки для
    нескольких route alternates без лишних /route запросов.

    `baseline_s` is used as-is — it is NOT replaced by a matrix-derived value.
    Valhalla's /sources_to_targets has no concept of route alternates: an
    origin->destination matrix cell always reflects Valhalla's own single best
    path, which coincides with the PRIMARY option. For any other alternate whose
    real duration is longer, that would silently under-report this option's
    baseline and inflate every candidate's detour by the gap (confirmed on a
    Durango -> Steamboat alternate: an under-baseline by ~73 minutes pushed every
    real, nearby candidate over the detour threshold, producing zero stops on a
    route that isn't actually empty).

    to_poi_s/from_poi_s below are still Valhalla-matrix optimal-path times, while
    baseline_s is this option's own corridor duration — a deliberate mismatch:
    detour_s now means "how much longer THIS route becomes if you detour here",
    which is what's needed. Precision could improve later if it matters.
    """
    decoded_points = polyline_lib.decode(route_shape, 6)
    route_wkt = _to_linestring_wkt(_thin_points(decoded_points))

    candidates = await poi.find_candidates_along_route(
        route_wkt=route_wkt,
        radius_m=radius_m,
        categories=categories,
        min_review_count=min_review_count,
        limit=limit,
    )
    candidates_found = len(candidates)

    if not candidates:
        return {
            "baseline_s": baseline_s,
            "route_shape": route_shape,
            "candidates_found": 0,
            "stops": [],
            "unreachable": [],
            "near_endpoints": [],
            "min_endpoint_distance_s_used": _resolve_min_endpoint_distance_s(
                min_endpoint_distance_s, baseline_s
            ),
        }

    poi_points = [(c["lat"], c["lon"]) for c in candidates]

    m1 = await routing.matrix(sources=[origin], targets=poi_points)
    m2 = await routing.matrix(sources=poi_points, targets=[destination])

    to_poi_raw = [cell["time"] for cell in m1[0]]
    from_poi_raw = [row[0]["time"] for row in m2]

    min_endpoint_distance_s_used = _resolve_min_endpoint_distance_s(min_endpoint_distance_s, baseline_s)

    # Drop POIs right next to origin/destination before compute_detours, rebuilding
    # parallel lists so DetourResult.index stays aligned with filtered_candidates.
    filtered_candidates = []
    to_poi = []
    from_poi = []
    near_endpoints = []
    for candidate, t, f in zip(candidates, to_poi_raw, from_poi_raw):
        near_a = t is not None and t < min_endpoint_distance_s_used
        near_b = f is not None and f < min_endpoint_distance_s_used
        if near_a or near_b:
            near_endpoints.append({"id": candidate["id"], "name": candidate["name"]})
            continue
        filtered_candidates.append(candidate)
        to_poi.append(t)
        from_poi.append(f)

    results = detour.compute_detours(
        baseline_s=baseline_s,
        to_poi=to_poi,
        from_poi=from_poi,
        max_detour_s=max_detour_s,
    )

    stops = []
    unreachable = []
    for result in results:
        candidate = filtered_candidates[result.index]
        if result.reachable:
            stops.append(
                {
                    "id": candidate["id"],
                    "name": candidate["name"],
                    "category": candidate["category"],
                    "rating": candidate["rating"],
                    "review_count": candidate["review_count"],
                    "about": candidate["about"],
                    "website": candidate["website"],
                    "duration": candidate["duration"],
                    "lat": candidate["lat"],
                    "lon": candidate["lon"],
                    "detour_s": result.detour_s,
                    "to_poi_s": result.to_poi_s,
                    "from_poi_s": result.from_poi_s,
                }
            )
        else:
            unreachable.append({"id": candidate["id"], "name": candidate["name"]})

    _mark_suggested(stops, baseline_s, pace)

    # Natural reading order is position along the route (time from origin), not
    # detour size — detour_s stays in the response as a filter/metric, not an order.
    stops.sort(key=lambda s: s["to_poi_s"])

    return {
        "baseline_s": baseline_s,
        "route_shape": route_shape,
        "candidates_found": candidates_found,
        "stops": stops,
        "unreachable": unreachable,
        "near_endpoints": near_endpoints,
        "min_endpoint_distance_s_used": min_endpoint_distance_s_used,
    }


async def find_stops(
    origin: tuple[float, float],
    destination: tuple[float, float],
    categories: list[str],
    max_detour_s: int,
    radius_m: int = 20000,
    limit: int = 50,
    min_review_count: int = 20,
    min_endpoint_distance_s: int | None = None,
    pace: Literal["relaxed", "balanced", "packed"] = "balanced",
) -> dict:
    """Оркестрирует routing.py, poi.py и detour.py, чтобы найти POI вдоль маршрута."""
    route = await asyncio.to_thread(
        routing.get_route, origin[0], origin[1], destination[0], destination[1]
    )
    return await _find_stops_for_route(
        route_shape=route["shape"],
        baseline_s=route["duration_seconds"],
        origin=origin,
        destination=destination,
        categories=categories,
        max_detour_s=max_detour_s,
        pace=pace,
        radius_m=radius_m,
        limit=limit,
        min_review_count=min_review_count,
        min_endpoint_distance_s=min_endpoint_distance_s,
    )


def _nearest_point_index(points: list[tuple[float, float]], target: tuple[float, float]) -> int:
    """Index of the corridor point nearest `target`. Plain squared lat/lon distance,
    not haversine — the corridor is already decimated to ~500 points, so this is
    precise enough, and it only runs a handful of times (once per stop) per request."""
    best_idx = 0
    best_dist = float("inf")
    for i, p in enumerate(points):
        d = (p[0] - target[0]) ** 2 + (p[1] - target[1]) ** 2
        if d < best_dist:
            best_dist = d
            best_idx = i
    return best_idx


def _pick_via_indices(num_points: int, via_count: int) -> list[int]:
    """Evenly spaced interior indices into a corridor point list — never the first
    or last point, since those already coincide with origin/destination."""
    if via_count <= 0 or num_points < 3:
        return []
    lo, hi = 1, num_points - 2
    if hi < lo:
        return []
    n = min(via_count, hi - lo + 1)
    if n == 1:
        return [(lo + hi) // 2]
    step = (hi - lo) / (n - 1)
    return sorted({round(lo + step * i) for i in range(n)})


async def build_route_through(
    origin: tuple[float, float],
    destination: tuple[float, float],
    stop_coords: list[tuple[float, float]],
    corridor_shape: str | None = None,
    corridor_via_count: int = 8,
) -> dict:
    """Builds one Valhalla route through origin -> stop_coords -> destination, in
    that exact order — the caller decides ordering, this never reorders stops.

    Without `corridor_shape`, Valhalla is free to optimize across the whole road
    network and can land on a completely different real-world route than the
    option it's supposed to represent — confirmed on a Durango -> Steamboat
    alternate, where a 4-stop through-route drifted onto a *different* option's
    corridor (its bbox extended exactly as far west as that other option's route,
    well past its own base route), and in the zero-stop case a through-route
    degenerated to an exact byte-for-byte match of the primary option's route.
    When `corridor_shape` (the option's own base route) is given, interior points
    of it are added as Valhalla "via" waypoints, slotted in between the stops, to
    pin the route back to where it belongs. Via points never split legs; only the
    stops (and origin/destination) do.

    Stop order is stop_coords' order, PERIOD — the caller already sorted these by
    to_poi_s (time from origin along this option's route, as measured by the
    router) and that ordering is never second-guessed here. Geometric proximity to
    corridor_shape's points is a rough heuristic, good only for deciding which via
    points fall before/after/between a given stop — it breaks down on switchbacks
    (confirmed on the Million Dollar Highway's hairpins near Ouray, where the
    nearest-point match alone put Box Canyon ahead of Ouray Alchemist Museum
    despite the latter having the smaller to_poi_s — Valhalla then had to backtrack
    through the hairpin to satisfy that order, inflating delta_s 4x). Reordering
    break points by geometry is exactly the mistake that caused that.
    """
    if corridor_shape:
        corridor_points = polyline_lib.decode(corridor_shape, 6)
        via_indices = _pick_via_indices(len(corridor_points), corridor_via_count)

        # Corridor index per stop, in the caller's given order — used only to
        # decide which via points precede/follow it, never to reorder the stops.
        # Clamped non-decreasing: if a stop's raw nearest-point match lands behind
        # the previous stop's (a switchback fooling the geometry), pin it forward
        # instead so via points can't be shoved behind it and end up out of order.
        stop_boundaries = []
        last_idx = 0
        for stop in stop_coords:
            last_idx = max(_nearest_point_index(corridor_points, stop), last_idx)
            stop_boundaries.append(last_idx)

        locations = [{"lat": origin[0], "lon": origin[1], "type": "break"}]
        via_iter = iter(via_indices)
        next_via = next(via_iter, None)

        for stop, boundary in zip(stop_coords, stop_boundaries):
            while next_via is not None and next_via < boundary:
                pt = corridor_points[next_via]
                locations.append({"lat": pt[0], "lon": pt[1], "type": "via"})
                next_via = next(via_iter, None)
            locations.append({"lat": stop[0], "lon": stop[1], "type": "break"})

        # Remaining via points (at/after the last stop's boundary, or all of them
        # when there are no stops at all) go after the last stop, before destination.
        while next_via is not None:
            pt = corridor_points[next_via]
            locations.append({"lat": pt[0], "lon": pt[1], "type": "via"})
            next_via = next(via_iter, None)

        locations.append({"lat": destination[0], "lon": destination[1], "type": "break"})
    else:
        locations = [
            {"lat": lat, "lon": lon, "type": "break"}
            for lat, lon in [origin, *stop_coords, destination]
        ]

    result = await asyncio.to_thread(routing.get_route_multi, locations)

    # Legs form only between "break" locations (origin, each stop, destination) —
    # via points never split a leg — so this indexing is unaffected by how many
    # via points were interleaved above.
    legs = [
        {
            "from_index": i,
            "to_index": i + 1,
            "duration_s": leg_summary["time"],
            "distance_km": leg_summary["length"],
        }
        for i, leg_summary in enumerate(result["leg_summaries"])
    ]

    return {
        "total_s": result["duration_seconds"],
        "distance_km": result["distance_km"],
        "route_shape": result["shape"],
        "legs": legs,
    }


async def compare_routes(
    origin: tuple[float, float],
    destination: tuple[float, float],
    categories: list[str],
    max_detour_s: int,
    pace: str = "balanced",
    alternates: int = 2,
    radius_m: int = 20000,
    limit: int = 50,
    min_review_count: int = 20,
) -> dict:
    """Fetches up to `alternates` route alternatives and, for each, the stops along
    it plus the real through-route built from its suggested stops — so the caller
    can compare options on actual numbers, not just raw drive time."""
    route_options = await routing.get_route_alternates(origin, destination, alternates)

    async def _build_option(index: int, route_option: dict) -> dict:
        stops_result = await _find_stops_for_route(
            route_shape=route_option["shape"],
            baseline_s=route_option["duration_s"],
            origin=origin,
            destination=destination,
            categories=categories,
            max_detour_s=max_detour_s,
            pace=pace,
            radius_m=radius_m,
            limit=limit,
            min_review_count=min_review_count,
            min_endpoint_distance_s=None,
        )
        stops = stops_result["stops"]

        suggested_coords = [(s["lat"], s["lon"]) for s in stops if s["suggested"]]

        through_shape = None
        total_s = None
        delta_s = None
        try:
            through_result = await build_route_through(
                origin, destination, suggested_coords,
                corridor_shape=route_option["shape"],
            )
            through_shape = through_result["route_shape"]
            total_s = through_result["total_s"]
            # NOT sum(s["detour_s"] for s in ...): each detour_s is measured against the
            # direct route in isolation, so stops sharing a road "split" the detour between
            # them — summing them badly overstates the real cost. This is the one honest
            # number, straight from the actual multi-stop route Valhalla just built.
            delta_s = total_s - route_option["duration_s"]
        except httpx.HTTPError:
            # One option's route-through failing (Valhalla hiccup, etc.) shouldn't sink
            # the whole comparison — the other stats for this option are still useful.
            pass

        ratings = [s["rating"] for s in stops if s["rating"] is not None]
        avg_rating = sum(ratings) / len(ratings) if ratings else None

        top_stops = sorted(stops, key=lambda s: s["review_count"] or 0, reverse=True)[:3]
        top_stops = [
            {
                "id": s["id"],
                "name": s["name"],
                "category": s["category"],
                "rating": s["rating"],
                "review_count": s["review_count"],
                "detour_s": s["detour_s"],
            }
            for s in top_stops
        ]

        return {
            "index": index,
            "duration_s": route_option["duration_s"],
            "distance_km": route_option["distance_km"],
            "route_shape": route_option["shape"],
            "through_shape": through_shape,
            "total_s": total_s,
            "delta_s": delta_s,
            "stops": stops,
            "candidates_found": stops_result["candidates_found"],
            "avg_rating": avg_rating,
            "top_stops": top_stops,
            "near_endpoints": stops_result["near_endpoints"],
            "unreachable": stops_result["unreachable"],
        }

    options = await asyncio.gather(
        *[_build_option(i, route_option) for i, route_option in enumerate(route_options)]
    )

    return {"options": list(options)}


def build_enrichment_dto(
    origin_name: str,
    destination_name: str,
    trip_dates: str | None,
    total_duration_s: int,
    baseline_duration_s: int,
    delta_s: int,
    distance_km: float,
    stops: list[dict],
) -> dict:
    """Shapes the plain dict enrichment.enrich_route expects — kept separate from
    enrichment.py so that module never has to know the HTTP request shape (or
    anything about Valhalla/PostGIS/Google Directions), only a generic dto."""
    return {
        "origin": origin_name,
        "destination": destination_name,
        "trip_dates": trip_dates,
        "total_duration_s": total_duration_s,
        "baseline_duration_s": baseline_duration_s,
        "delta_s": delta_s,
        "distance_km": distance_km,
        "stops": stops,
    }
