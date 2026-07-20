import asyncio
import os

import httpx
import polyline as polyline_lib
from dotenv import load_dotenv

import day_split

load_dotenv()

GOOGLE_DIRECTIONS_KEY = os.getenv("GOOGLE_DIRECTIONS_KEY")
DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json"

# Google's documented cap on waypoints per request.
_MAX_WAYPOINTS = 25

# (origin, destination, waypoints-tuple) -> result. Directions calls are billed,
# so an in-memory cache (same convention as geocoding.py) avoids paying twice
# for an identical request within the process lifetime.
_cache: dict[tuple, dict] = {}


class DirectionsError(Exception):
    """Google Directions не смог построить маршрут (лимит waypoints, статус не OK)."""


async def get_directions(
    origin: tuple[float, float],
    destination: tuple[float, float],
    waypoints: list[tuple[float, float]] | None = None,
) -> dict:
    """Просит у Google Directions маршрут origin -> waypoints -> destination, в
    заданном порядке — никогда не переупорядочивает и не оптимизирует.

    ВАЖНО: `shape` в результате — НЕ сырой overview_polyline от Google (тот
    заметно упрощён, см. комментарий ниже), а геометрия, пересобранная из
    legs[].steps[].polyline. Формат кодирования тот же — precision 5. Это НЕ
    формат Valhalla (precision 6) — у вызывающего кода (и на фронте) должен
    быть отдельный precision-5 декодер; общий Valhalla-декодер (precision 6)
    на этой строке даст неверные координаты.
    """
    waypoints = waypoints or []
    if len(waypoints) > _MAX_WAYPOINTS:
        raise DirectionsError(
            f"Слишком много точек для Google Directions: {len(waypoints)} (максимум {_MAX_WAYPOINTS})."
        )

    cache_key = (origin, destination, tuple(waypoints))
    if cache_key in _cache:
        return _cache[cache_key]

    params = {
        "origin": f"{origin[0]},{origin[1]}",
        "destination": f"{destination[0]},{destination[1]}",
        "key": GOOGLE_DIRECTIONS_KEY,
    }
    if waypoints:
        # Plain stopover waypoints, NOT "via:" — confirmed against Google's docs
        # that order is preserved as given as long as "optimize:true" is never
        # added (it isn't, on purpose: the caller has already decided the
        # order). "via:" would also preserve order, but it collapses the whole
        # route into a single leg with no stop in between, which is wrong here
        # — day_split.py (see main.py's /detail-route) needs one leg per hop
        # (origin->stop_1->...->stop_N->dest) to measure actual per-day drive
        # time, not just the trip's aggregate duration.
        params["waypoints"] = "|".join(f"{lat},{lng}" for lat, lng in waypoints)

    async with httpx.AsyncClient() as client:
        response = await client.get(DIRECTIONS_URL, params=params, timeout=20.0)
    response.raise_for_status()
    data = response.json()

    if data.get("status") != "OK" or not data.get("routes"):
        raise DirectionsError(
            f"Google Directions: {data.get('status')} {data.get('error_message', '')}".strip()
        )

    route = data["routes"][0]

    # route["overview_polyline"] is Google's own SIMPLIFIED preview geometry, not
    # the real road-following path — confirmed on a real switchback route (Durango
    # -> Ouray, Million Dollar Highway): 312 overview points vs 8199 points
    # assembled from legs[].steps[].polyline, a 26x density difference. Coarse
    # enough to cut straight across hairpins instead of following them. Assemble
    # the real shape from every step's own polyline instead, still precision 5,
    # so the return format (one encoded string) is unchanged for callers.
    combined_points: list[tuple[float, float]] = []
    legs = []
    for leg in route["legs"]:
        for step in leg["steps"]:
            step_points = polyline_lib.decode(step["polyline"]["points"], 5)
            if combined_points and step_points and combined_points[-1] == step_points[0]:
                step_points = step_points[1:]
            combined_points.extend(step_points)
        legs.append({
            "duration_s": round(leg["duration"]["value"]),
            "distance_km": leg["distance"]["value"] / 1000,
        })

    result = {
        "duration_s": round(sum(leg["duration_s"] for leg in legs)),
        "distance_km": sum(leg["distance_km"] for leg in legs),
        "shape": polyline_lib.encode(combined_points, 5),
        "legs": legs,
    }

    _cache[cache_key] = result
    return result


async def get_route_detail(
    origin: tuple[float, float],
    destination: tuple[float, float],
    waypoints: list[tuple[float, float]],
    daily_limit_s: int = 28800,
    visit_s: int = 3600,
    planned_days: int | None = None,
    flexible_days: bool = False,
    awake_limit_s: int = 43200,  # "balanced" pace's cap — see services.stops.awake_limit_s_for_pace
) -> dict:
    """Orchestrates get_directions (twice — with the stops, and again with no
    waypoints for the baseline) plus day_split.split_into_days into one
    "detailed route" result. Shared by /detail-route (main.py, still public
    per its own temporary-access comment) and Finalize's real pipeline
    (finalize.py) — written once here so neither has to duplicate it.

    Raises DirectionsError (bad Google status, e.g. ZERO_RESULTS for a point
    with no road access) or an httpx transport/HTTP error — callers decide
    what that means for them (502 for the HTTP endpoint, job failure +
    mandatory refund for Finalize). Not caught here on purpose.
    """
    result = await get_directions(origin, destination, waypoints)
    # Baseline MUST also come from Google — subtracting a Valhalla baseline
    # here would mix sources (Valhalla systematically over-estimates by
    # 30-46%) and produce a meaningless delta. Two paid calls, deliberately.
    baseline = await get_directions(origin, destination, None)
    baseline_s = baseline["duration_s"]

    # result["legs"] (WITH the stops, not the no-waypoint baseline) is the
    # same Google-measured drive time day_split allocates against — accuracy
    # here is the whole point (see day_split.py's docstring / CLAUDE.md on
    # why Valhalla numbers aren't interchangeable with Google's).
    days = day_split.split_into_days(
        result["legs"],
        stop_count=len(waypoints),
        daily_limit_s=daily_limit_s,
        visit_s=visit_s,
        awake_limit_s=awake_limit_s,
    )
    actual_days = len(days)

    fits_plan = None
    if planned_days is not None:
        allowed = planned_days + (1 if flexible_days else 0)
        fits_plan = actual_days <= allowed

    return {
        **result,
        "baseline_s": baseline_s,
        "delta_s": result["duration_s"] - baseline_s,
        "days": days,
        "planned_days": planned_days,
        "actual_days": actual_days,
        "fits_plan": fits_plan,
    }


def concat_shapes_p5(shape1: str, shape2: str) -> str:
    """Same join-and-dedupe as services.stops._concat_shapes, but for Google's
    precision-5 polylines — kept separate rather than shared because mixing a
    precision-5 decode/encode with Valhalla's precision-6 helper would silently
    corrupt coordinates (see the module docstring on get_directions). Public
    (no leading underscore) because finalize.py's lodging path needs the same
    join for its own two independent per-leg Directions results."""
    points1 = polyline_lib.decode(shape1, 5)
    points2 = polyline_lib.decode(shape2, 5)
    if points1 and points2 and points1[-1] == points2[0]:
        points2 = points2[1:]
    return polyline_lib.encode(points1 + points2, 5)


async def get_route_detail_round_trip(
    origin: tuple[float, float],
    pivot: tuple[float, float],
    leg1_stops: list[tuple[float, float]],
    leg2_stops: list[tuple[float, float]],
    daily_limit_s: int = 28800,
    visit_s: int = 3600,
    planned_days: int | None = None,
    flexible_days: bool = False,
    awake_limit_s: int = 43200,  # "balanced" pace's cap — see services.stops.awake_limit_s_for_pace
) -> dict:
    """Round-trip counterpart to get_route_detail: TWO independent Directions
    legs — A->pivot via leg1_stops, pivot->A via leg2_stops — each with its own
    Google-measured baseline (no mixing Valhalla numbers in, same reasoning as
    get_route_detail), concatenated into ONE continuous sequence before
    day_split ever sees it.

    day_split.py stays completely unmodified and never learns round trips
    exist: the pivot is made an ordinary, non-day-breaking waypoint purely by
    merging the two legs adjacent to it (last leg1 hop, first leg2 hop) into a
    single summed hop, and excluding the pivot from stop_count. That merged
    legs list — length stop_count+1 where stop_count = len(leg1_stops) +
    len(leg2_stops) — is also what's returned as "legs", since finalize.py's
    lodging path slices days back out of exactly this list by n_legs.
    """
    (leg1_result, leg1_baseline), (leg2_result, leg2_baseline) = await asyncio.gather(
        asyncio.gather(
            get_directions(origin, pivot, leg1_stops),
            get_directions(origin, pivot, None),
        ),
        asyncio.gather(
            get_directions(pivot, origin, leg2_stops),
            get_directions(pivot, origin, None),
        ),
    )
    baseline_s = leg1_baseline["duration_s"] + leg2_baseline["duration_s"]

    pivot_leg = {
        "duration_s": leg1_result["legs"][-1]["duration_s"] + leg2_result["legs"][0]["duration_s"],
        "distance_km": leg1_result["legs"][-1]["distance_km"] + leg2_result["legs"][0]["distance_km"],
    }
    merged_legs = leg1_result["legs"][:-1] + [pivot_leg] + leg2_result["legs"][1:]
    stop_count = len(leg1_stops) + len(leg2_stops)

    days = day_split.split_into_days(
        merged_legs,
        stop_count=stop_count,
        daily_limit_s=daily_limit_s,
        visit_s=visit_s,
        awake_limit_s=awake_limit_s,
    )
    actual_days = len(days)

    fits_plan = None
    if planned_days is not None:
        allowed = planned_days + (1 if flexible_days else 0)
        fits_plan = actual_days <= allowed

    duration_s = leg1_result["duration_s"] + leg2_result["duration_s"]

    return {
        "duration_s": duration_s,
        "distance_km": leg1_result["distance_km"] + leg2_result["distance_km"],
        "shape": concat_shapes_p5(leg1_result["shape"], leg2_result["shape"]),
        "legs": merged_legs,
        "baseline_s": baseline_s,
        "delta_s": duration_s - baseline_s,
        "days": days,
        "planned_days": planned_days,
        "actual_days": actual_days,
        "fits_plan": fits_plan,
    }
