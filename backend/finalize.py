import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

import accommodations
import day_split
import directions
import enrichment
import trips
from db import get_pool
from services import stops as stops_service


class TripNotFoundError(Exception):
    """No trip with that id owned by this user — same indistinguishable-404
    reasoning used everywhere else in this app (trips.py): never confirm to
    the caller that a project exists but belongs to someone else."""


class InsufficientCreditsError(Exception):
    def __init__(self, balance: int):
        self.balance = balance
        super().__init__(f"insufficient credits: balance={balance}")


@dataclass
class FinalizationJob:
    id: uuid.UUID
    status: str
    trip_version_id: uuid.UUID | None
    error: str | None
    # False when this call returned an ALREADY-existing job (idempotency
    # replay, or another in-flight attempt on the same project) rather than
    # creating a new one — the caller (main.py) uses this to decide whether
    # to schedule process_finalization at all. Scheduling it for an existing
    # job would double-process it (two background tasks racing the same
    # pending -> processing -> done transition).
    is_new: bool


async def start_finalization(
    user_id: uuid.UUID,
    session_id: uuid.UUID,
    trip_project_id: uuid.UUID,
    idempotency_key: str,
) -> FinalizationJob:
    """Charges 1 Trip Credit and creates a finalization_jobs row, all in one
    transaction — a half-completed charge (credit gone, no job to show for
    it) would be strictly worse than the whole attempt failing and the
    frontend retrying.

    Two row locks, for two different races:
    - `trip_projects ... FOR UPDATE` serializes concurrent finalize attempts
      on the SAME project (two tabs, a double-click that didn't reuse the
      idempotency key) — the second call blocks here until the first
      commits, then sees the project already 'finalizing' and the in-flight
      job created by the first, instead of racing it to create a second job.
    - `credit_accounts ... FOR UPDATE` serializes concurrent attempts across
      ANY of this user's projects — what actually protects the balance from
      going negative under concurrent charges.

    session_id is this REQUEST's own anonymous_session_id (session.id in
    main.py, always present regardless of login state) — used ONLY for the
    ownership backfill immediately below, never as a substitute for the
    strict owner_user_id check that follows it.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Ownership backfill, NOT a relaxed ownership check: trips.py's
            # save_draft now sets owner_user_id at creation time for a
            # session that's already logged in, but a project created before
            # this fix (or in some other edge case) can still have
            # owner_user_id NULL with only anonymous_session_id set — the
            # same situation claim_session_for_google_user (auth.py) fixes
            # at login, except that event never fires again for someone
            # already signed in. This assigns ownership ONLY when THIS
            # request's own session proves the project is this user's:
            # anonymous_session_id must match the CALLER's session_id, and
            # the row must not already belong to anyone (owner_user_id IS
            # NULL — never overwrites an existing owner, same invariant the
            # login-time claim relies on). The strict SELECT ... FOR UPDATE
            # right after this is completely unchanged and is still the
            # actual gate — this step only makes sure a project that
            # legitimately belongs to this session/user can be SEEN by it.
            await conn.execute(
                """
                UPDATE app.trip_projects
                SET owner_user_id = $1
                WHERE id = $2 AND anonymous_session_id = $3 AND owner_user_id IS NULL
                """,
                user_id, trip_project_id, session_id,
            )

            trip_row = await conn.fetchrow(
                "SELECT id FROM app.trip_projects WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
                trip_project_id, user_id,
            )
            if trip_row is None:
                raise TripNotFoundError(str(trip_project_id))

            # Idempotency replay: identical (trip_project_id, idempotency_key)
            # already has a job — return it verbatim, charge nothing again.
            existing = await conn.fetchrow(
                """
                SELECT id, status, trip_version_id, error
                FROM app.finalization_jobs
                WHERE trip_project_id = $1 AND idempotency_key = $2
                """,
                trip_project_id, idempotency_key,
            )
            if existing is not None:
                return FinalizationJob(
                    id=existing["id"], status=existing["status"],
                    trip_version_id=existing["trip_version_id"], error=existing["error"],
                    is_new=False,
                )

            # Different idempotency key, but this project already has a job
            # actively being worked on — hand that back instead of starting
            # a second, parallel finalization (and a second charge) for it.
            in_flight = await conn.fetchrow(
                """
                SELECT id, status, trip_version_id, error
                FROM app.finalization_jobs
                WHERE trip_project_id = $1 AND status IN ('pending', 'processing')
                ORDER BY created_at DESC
                LIMIT 1
                """,
                trip_project_id,
            )
            if in_flight is not None:
                return FinalizationJob(
                    id=in_flight["id"], status=in_flight["status"],
                    trip_version_id=in_flight["trip_version_id"], error=in_flight["error"],
                    is_new=False,
                )

            account = await conn.fetchrow(
                "SELECT balance FROM app.credit_accounts WHERE user_id = $1 FOR UPDATE",
                user_id,
            )
            balance = account["balance"] if account is not None else 0
            if balance < 1:
                raise InsufficientCreditsError(balance)

            await conn.execute(
                "UPDATE app.credit_accounts SET balance = balance - 1 WHERE user_id = $1",
                user_id,
            )
            await conn.execute(
                "INSERT INTO app.credit_ledger (user_id, amount, reason) VALUES ($1, -1, $2)",
                user_id, f"finalize:{trip_project_id}",
            )

            job_row = await conn.fetchrow(
                """
                INSERT INTO app.finalization_jobs (trip_project_id, user_id, status, idempotency_key)
                VALUES ($1, $2, 'pending', $3)
                RETURNING id, status, trip_version_id, error
                """,
                trip_project_id, user_id, idempotency_key,
            )

            await conn.execute(
                "UPDATE app.trip_projects SET status = 'finalizing' WHERE id = $1",
                trip_project_id,
            )

    return FinalizationJob(
        id=job_row["id"], status=job_row["status"],
        trip_version_id=job_row["trip_version_id"], error=job_row["error"],
        is_new=True,
    )


class SnapshotBuildError(Exception):
    """draft_state has nothing buildable (no options, no active option, no
    routeOrigin/routeDest) — the trip never got far enough in `refine` for a
    real route to exist. Caught by process_finalization's own broad except
    exactly like a Google/Gemini failure — refund applies the same way."""


# Mirrors frontend/src/quizMapping.ts::mapDriveToDailyLimitS. Finalize runs
# entirely server-side (a background job, no request from the browser), so
# there's no client-mapped daily_limit_s to receive the way /detail-route
# gets one — the quiz's raw text answer has to be re-mapped here instead.
_DRIVE_TO_DAILY_LIMIT_S = {
    "до 3 ч": 10800,
    "до 4 ч": 14400,
    "до 6 ч": 21600,
    "не важно": 28800,
}
_DEFAULT_DAILY_LIMIT_S = 14400  # same default as quizMapping.ts, for "до 4 ч"


def _daily_limit_s_from_quiz(quiz_answers: dict | None) -> int:
    drive = (quiz_answers or {}).get("drive")
    if not isinstance(drive, str):
        return _DEFAULT_DAILY_LIMIT_S
    return _DRIVE_TO_DAILY_LIMIT_S.get(drive, _DEFAULT_DAILY_LIMIT_S)


# Mirrors frontend/src/quizMapping.ts::mapDetourToMaxDetourS — same reasoning
# as _daily_limit_s_from_quiz above, this time for the lodging preview
# (Фаза ночёвок, подшаг 1), which also runs server-side with only the quiz's
# raw text to work from.
_DETOUR_TO_MAX_DETOUR_S = {
    "до 15 мин": 900,
    "до 30 мин": 1800,
    "до 45 мин": 2700,
    "до часа": 3600,
}
_DEFAULT_MAX_DETOUR_S = 1800  # same default as quizMapping.ts, for "до 30 мин"


def _max_detour_s_from_quiz(quiz_answers: dict | None) -> int:
    detour = (quiz_answers or {}).get("detour")
    if not isinstance(detour, str):
        return _DEFAULT_MAX_DETOUR_S
    return _DETOUR_TO_MAX_DETOUR_S.get(detour, _DEFAULT_MAX_DETOUR_S)


# "1 minute of detour tolerance ~= 1 km of straight-line lodging search
# radius" — assumes ~60 km/h on the secondary/mountain roads typical near an
# overnight stop (slower than highway). There's no distance-equivalent
# anywhere in the quiz to convert from instead; this is a documented,
# easily-tunable assumption, not a measured conversion.
_METERS_PER_DETOUR_SECOND = 1000 / 60


def _lodging_radius_m_from_quiz(quiz_answers: dict | None) -> int:
    return round(_max_detour_s_from_quiz(quiz_answers) * _METERS_PER_DETOUR_SECOND)


# Mirrors frontend/src/quizMapping.ts::mapPaceToApiPace — same reasoning as
# _daily_limit_s_from_quiz above. Also THE source of pace for day_split's
# awake_limit_s (via stops_service.awake_limit_s_for_pace) in this module —
# reusing this one mapping rather than a second, separately-invented one
# keeps finalize's day split and the draft's POI-suggestion pace (which reads
# the same quiz answer, just client-side via /compare-routes) from ever
# disagreeing on what "relaxed"/"balanced"/"packed" means for a given trip.
_PACE_TO_API_PACE = {
    "спокойный": "relaxed",
    "сбалансированный": "balanced",
    "насыщенный": "packed",
}
_DEFAULT_API_PACE = "relaxed"  # same default as quizMapping.ts, for "спокойный"


def _pace_from_quiz(quiz_answers: dict | None) -> str:
    pace = (quiz_answers or {}).get("pace")
    if not isinstance(pace, str):
        return _DEFAULT_API_PACE
    return _PACE_TO_API_PACE.get(pace, _DEFAULT_API_PACE)


def _is_round_trip_from_quiz(quiz_answers: dict | None) -> bool:
    """Mirrors the frontend QUIZ's "trip" field (src/data.ts) — same re-mapping
    pattern as _daily_limit_s_from_quiz/_max_detour_s_from_quiz above, since
    finalize runs server-side from the raw quiz answer, not a client-computed
    flag."""
    return (quiz_answers or {}).get("trip") == "Туда и обратно"


def _split_included_stops_by_leg(included_stops: list[dict]) -> tuple[list[dict], list[dict]]:
    """Round-trip's included_stops (from _parse_active_selection) come back as
    ONE list, already globally ordered by to_poi_s — leg1 stops before leg2
    stops, per find_stops_for_round_trip's offset trick (services/stops.py).
    Splits them back into the two legs by their "leg" tag (0/1) so finalize
    can build/search each leg independently again, the same way
    compare_routes originally did. A stop missing the tag defaults to leg 0
    — shouldn't happen for a round-trip option (main.py's StopOut always
    carries it once populated by find_stops_for_round_trip), but a silent
    default is safer here than crashing finalize on a stray draft_state."""
    leg1 = [s for s in included_stops if s.get("leg") != 1]
    leg2 = [s for s in included_stops if s.get("leg") == 1]
    return leg1, leg2


def _parse_active_selection(trip: dict) -> tuple[tuple[float, float], tuple[float, float], list[dict]]:
    """Active option + its included stops (sorted by to_poi_s, same order
    the free 'plan' phase already sends to /route-through) from
    trip['draft_state'] — shared by the free preview
    (build_finalize_preview) and the paid pipeline (_build_finalized_snapshot),
    so both read draft_state exactly the same way and can never quietly drift
    apart on what "the selection" means.

    Raises SnapshotBuildError if there's nothing buildable yet (the trip
    never got far enough in `refine` for a real route to exist).
    """
    draft_state = trip["draft_state"] or {}
    options = draft_state.get("options") or []
    active_index = draft_state.get("activeOptionIndex")
    route_origin = draft_state.get("routeOrigin")
    route_dest = draft_state.get("routeDest")

    if (
        not isinstance(active_index, int)
        or not (0 <= active_index < len(options))
        or route_origin is None
        or route_dest is None
    ):
        raise SnapshotBuildError(f"trip project {trip['id']} has no buildable draft_state")

    active_option = options[active_index]
    stops_by_id = {s["id"]: s for s in active_option.get("stops") or []}

    included_ids: list[int] = []
    for pair in draft_state.get("includedByOption") or []:
        if pair[0] == active_index:
            included_ids = pair[1]
            break

    included_stops = sorted(
        (stops_by_id[sid] for sid in included_ids if sid in stops_by_id),
        key=lambda s: s["to_poi_s"],
    )

    origin = (route_origin["lat"], route_origin["lng"])
    destination = (route_dest["lat"], route_dest["lng"])
    return origin, destination, included_stops


async def build_finalize_preview(trip: dict) -> dict:
    """Free preview (Фаза ночёвок, подшаг 1): a Valhalla-estimated day split
    (same engine/precision as the free draft — see PlanPanel's "(оценка)"
    labeling) plus lodging options at each night's end point, BEFORE any
    credit is spent. Google Directions and Gemini are never called here —
    this is the screen that now sits in front of what used to be an
    immediate paid confirm step.

    Reuses services.stops.build_route_through (the same Valhalla route-
    through the free 'plan' phase already calls on every checkbox toggle)
    and day_split.split_into_days completely as-is — this function only
    feeds it real per-leg times and post-processes its output (end_point,
    lodging_options). day_split itself stays entirely unaware that lodging
    exists; see _build_route_detail_with_lodging's docstring for why that
    split is deliberate.

    Round-trip (see _is_round_trip_from_quiz): `destination` here is the
    loop's pivot X, not where the trip actually ends — build_route_through_
    round_trip is used instead (same merged, pivot-as-ordinary-waypoint legs
    day_split expects, see its own docstring), and the LAST day's end_point
    is `origin` (the trip returns there), not the pivot.
    """
    origin, destination, included_stops = _parse_active_selection(trip)

    quiz_answers = trip["quiz_answers"] or {}
    daily_limit_s = _daily_limit_s_from_quiz(quiz_answers)
    awake_limit_s = stops_service.awake_limit_s_for_pace(_pace_from_quiz(quiz_answers))
    radius_m = _lodging_radius_m_from_quiz(quiz_answers)
    round_trip = _is_round_trip_from_quiz(quiz_answers)

    if round_trip:
        leg1_stops, leg2_stops = _split_included_stops_by_leg(included_stops)
        leg1_coords = [(s["lat"], s["lon"]) for s in leg1_stops]
        leg2_coords = [(s["lat"], s["lon"]) for s in leg2_stops]
        through = await stops_service.build_route_through_round_trip(origin, destination, leg1_coords, leg2_coords)
    else:
        stop_coords = [(s["lat"], s["lon"]) for s in included_stops]
        through = await stops_service.build_route_through(origin, destination, stop_coords)

    days = day_split.split_into_days(
        through["legs"], stop_count=len(included_stops),
        daily_limit_s=daily_limit_s, visit_s=3600, awake_limit_s=awake_limit_s,
    )

    has_lodging = False
    last_day_num = days[-1]["day"] if days else None
    trip_end = origin if round_trip else destination

    for day in days:
        is_last = day["day"] == last_day_num
        if is_last:
            end_point = {"lat": trip_end[0], "lon": trip_end[1], "near_stop_name": None}
        else:
            last_stop = included_stops[day["stop_indices"][-1]]
            end_point = {"lat": last_stop["lat"], "lon": last_stop["lon"], "near_stop_name": last_stop["name"]}
        day["end_point"] = end_point

        if is_last:
            # No overnight after the last day — nothing to search for.
            day["lodging_options"] = []
            continue

        try:
            candidates = await accommodations.find_nearest_lodging(
                end_point["lat"], end_point["lon"], radius_m, limit=20
            )
        except (accommodations.PlacesError, httpx.HTTPError):
            # A lodging-search hiccup for one night shouldn't sink the whole
            # free preview — the day split itself is still useful without it.
            candidates = []

        # rank_for_selection drops thin-review/unrated places ONLY when
        # enough reliable ones exist to fill the list — a remote corridor
        # with nothing but a two-review campground still gets that campground
        # shown, never an empty list (see its own docstring).
        options = accommodations.rank_for_selection(candidates)
        day["lodging_options"] = options
        if options:
            has_lodging = True

    return {
        "preliminary": True,
        "days": days,
        "has_lodging": has_lodging,
        # >1 day and at least one night has a real option — a 1-day trip (no
        # nights at all) or a corridor with nothing nearby anywhere both skip
        # straight to the paywall/confirm step, no empty picker shown.
        "needs_selection": len(days) > 1 and has_lodging,
    }


async def _build_route_detail_with_lodging(
    origin: tuple[float, float],
    destination: tuple[float, float],
    included_stops: list[dict],
    selected_lodging: list[dict],
    daily_limit_s: int,
    visit_s: int,
    awake_limit_s: int,
) -> dict:
    """Google-routed detail when the user picked lodging for one or more
    nights (Фаза ночёвок, подшаг 3). Waypoints become: day-1 stops,
    lodging-1, day-2 stops, lodging-2, ..., last-day stops — day boundaries
    are FIXED at each lodging pick, not discovered greedily. day_split.py
    stays entirely lodging-unaware by design: it has no concept of "this
    waypoint MUST end a day" (only "how much time is left"), so feeding it a
    mix of real stops and a chosen overnight would let it split wherever the
    clock says, possibly stranding the lodging pick mid-day instead of at
    the boundary the user actually chose. Fixed boundaries need different,
    simpler bookkeeping than that algorithm does — done inline below rather
    than bent into split_into_days' shape.

    The boundary POSITIONS (how many stops per day) come from re-running the
    exact same free preliminary Valhalla split build_finalize_preview showed
    the user, so selected_lodging[i]["day"] lines up with the same grouping
    they picked from. Every NUMBER in the returned days/legs is Google's,
    never Valhalla's — only where the boundaries fall is inherited from the
    free preview, not its timings. This means final day totals can differ
    slightly from what the preview showed (Valhalla -> Google, and the
    corridor could in principle have changed between preview and payment) —
    expected, not a bug, same as the existing Valhalla-vs-Google gap between
    the free draft and any finalized result.
    """
    lodging_by_day = {entry["day"]: entry for entry in selected_lodging}

    stop_coords = [(s["lat"], s["lon"]) for s in included_stops]
    through = await stops_service.build_route_through(origin, destination, stop_coords)
    prelim_days = day_split.split_into_days(
        through["legs"], stop_count=len(included_stops),
        daily_limit_s=daily_limit_s, visit_s=visit_s, awake_limit_s=awake_limit_s,
    )

    waypoints: list[tuple[float, float]] = []
    day_stop_counts: list[int] = []
    day_lodging: list[dict | None] = []
    for day in prelim_days:
        for idx in day["stop_indices"]:
            stop = included_stops[idx]
            waypoints.append((stop["lat"], stop["lon"]))
        day_stop_counts.append(len(day["stop_indices"]))

        lodging = lodging_by_day.get(day["day"])
        if lodging is not None:
            waypoints.append((lodging["lat"], lodging["lon"]))
        day_lodging.append(lodging)

    result = await directions.get_directions(origin, destination, waypoints)
    baseline = await directions.get_directions(origin, destination, None)

    days: list[dict] = []
    leg_cursor = 0
    stop_cursor = 0
    n_days = len(day_stop_counts)
    for i, (stop_count, lodging) in enumerate(zip(day_stop_counts, day_lodging)):
        # The final leg (last waypoint -> destination) belongs to whichever
        # day is last, same "closes wherever it lands" rule day_split.py
        # itself uses for the drive home.
        is_last_day = i == n_days - 1
        n_legs = stop_count + (1 if lodging is not None else 0) + (1 if is_last_day else 0)
        day_legs = result["legs"][leg_cursor: leg_cursor + n_legs]
        drive_s = sum(leg["duration_s"] for leg in day_legs)
        visit_total_s = visit_s * stop_count

        days.append({
            "day": i + 1,
            "stop_indices": list(range(stop_cursor, stop_cursor + stop_count)),
            "drive_s": drive_s,
            "visit_s": visit_total_s,
            "total_s": drive_s + visit_total_s,
            "over_limit": drive_s > daily_limit_s or (drive_s + visit_total_s) > awake_limit_s,
            "lodging": lodging,
        })
        leg_cursor += n_legs
        stop_cursor += stop_count

    return {
        "duration_s": result["duration_s"],
        "distance_km": result["distance_km"],
        "shape": result["shape"],
        "legs": result["legs"],
        "baseline_s": baseline["duration_s"],
        "delta_s": result["duration_s"] - baseline["duration_s"],
        "days": days,
    }


async def _build_route_detail_with_lodging_round_trip(
    origin: tuple[float, float],
    pivot: tuple[float, float],
    leg1_stops: list[dict],
    leg2_stops: list[dict],
    selected_lodging: list[dict],
    daily_limit_s: int,
    visit_s: int,
    awake_limit_s: int,
) -> dict:
    """Round-trip counterpart to _build_route_detail_with_lodging — same
    fixed-day-boundary reasoning (day_split.py stays lodging-unaware;
    boundary POSITIONS come from re-running the free preview's Valhalla
    split — build_route_through_round_trip's merged, pivot-unaware legs,
    exactly like build_finalize_preview; every NUMBER in the result is
    Google's). Extended for the one thing a round trip adds that a one-way
    route never has: a single day CAN legitimately straddle the leg1/leg2
    transition, since day_split's greedy algorithm has no concept of a leg
    boundary to respect.

    Two independent Google Directions calls, one per leg — never a single
    "origin equals destination" call, per the task spec. Each leg's day-by-
    day leg count mirrors the one-way function's own "stop_count + lodging +
    is_last" formula applied to ITS half of the trip:
    - leg1 gets an extra +1 on whichever day its cumulative stop count first
      reaches its own total — that's leg1's own "reached the destination"
      day, the pivot just happens to be that destination.
    - leg2 needs NO special-casing for the hop OUT of the pivot at all: it's
      just the ordinary "hop into this day's first stop", already covered by
      leg2's own stop_count the same way every other stop's entry hop is.
    - Lodging picked for a day that has already reached the pivot (by that
      day's end) sits on leg2's route; otherwise leg1's — a night can't be
      picked "at the pivot" itself, only somewhere along one of the two legs.
    """
    included_stops = leg1_stops + leg2_stops
    l1 = len(leg1_stops)
    lodging_by_day = {entry["day"]: entry for entry in selected_lodging}

    leg1_coords = [(s["lat"], s["lon"]) for s in leg1_stops]
    leg2_coords = [(s["lat"], s["lon"]) for s in leg2_stops]
    through = await stops_service.build_route_through_round_trip(origin, pivot, leg1_coords, leg2_coords)
    prelim_days = day_split.split_into_days(
        through["legs"], stop_count=len(included_stops),
        daily_limit_s=daily_limit_s, visit_s=visit_s, awake_limit_s=awake_limit_s,
    )

    leg1_waypoints: list[tuple[float, float]] = []
    leg2_waypoints: list[tuple[float, float]] = []
    day_leg1_counts: list[int] = []
    day_leg2_counts: list[int] = []
    day_lodging: list[dict | None] = []
    day_has_pivot: list[bool] = []

    leg1_running = 0
    pivot_assigned = False
    for day in prelim_days:
        stop_indices = day["stop_indices"]
        leg1_count = sum(1 for idx in stop_indices if idx < l1)
        leg2_count = len(stop_indices) - leg1_count
        for idx in stop_indices:
            stop = included_stops[idx]
            (leg1_waypoints if idx < l1 else leg2_waypoints).append((stop["lat"], stop["lon"]))

        leg1_running += leg1_count
        has_pivot = False
        if not pivot_assigned and leg1_running >= l1:
            has_pivot = True
            pivot_assigned = True

        lodging = lodging_by_day.get(day["day"])
        if lodging is not None:
            (leg2_waypoints if has_pivot else leg1_waypoints).append((lodging["lat"], lodging["lon"]))

        day_leg1_counts.append(leg1_count)
        day_leg2_counts.append(leg2_count)
        day_lodging.append(lodging)
        day_has_pivot.append(has_pivot)

    # Shouldn't happen (leg1_running caps out at l1 once every leg1 stop has
    # been seen, and >= l1 is already true from day 1 when l1 == 0), but
    # fail safe onto the last day the same way the final leg into the
    # destination always closes wherever it lands, one-way or not.
    if not pivot_assigned and day_has_pivot:
        day_has_pivot[-1] = True

    leg1_result = await directions.get_directions(origin, pivot, leg1_waypoints)
    leg2_result = await directions.get_directions(pivot, origin, leg2_waypoints)
    leg1_baseline = await directions.get_directions(origin, pivot, None)
    leg2_baseline = await directions.get_directions(pivot, origin, None)
    baseline_s = leg1_baseline["duration_s"] + leg2_baseline["duration_s"]

    days: list[dict] = []
    leg1_cursor = 0
    leg2_cursor = 0
    n_days = len(prelim_days)
    for i, day in enumerate(prelim_days):
        is_last_day = i == n_days - 1
        lodging = day_lodging[i]
        leg1_lodge = 1 if (lodging is not None and not day_has_pivot[i]) else 0
        leg2_lodge = 1 if (lodging is not None and day_has_pivot[i]) else 0

        n_leg1 = day_leg1_counts[i] + (1 if day_has_pivot[i] else 0) + leg1_lodge
        n_leg2 = day_leg2_counts[i] + leg2_lodge + (1 if is_last_day else 0)

        leg1_day_legs = leg1_result["legs"][leg1_cursor: leg1_cursor + n_leg1]
        leg2_day_legs = leg2_result["legs"][leg2_cursor: leg2_cursor + n_leg2]
        leg1_cursor += n_leg1
        leg2_cursor += n_leg2

        drive_s = sum(leg["duration_s"] for leg in leg1_day_legs) + sum(leg["duration_s"] for leg in leg2_day_legs)
        stop_count = len(day["stop_indices"])
        visit_total_s = visit_s * stop_count

        days.append({
            "day": day["day"],
            "stop_indices": day["stop_indices"],
            "drive_s": drive_s,
            "visit_s": visit_total_s,
            "total_s": drive_s + visit_total_s,
            "over_limit": drive_s > daily_limit_s or (drive_s + visit_total_s) > awake_limit_s,
            "lodging": lodging,
        })

    duration_s = leg1_result["duration_s"] + leg2_result["duration_s"]

    return {
        "duration_s": duration_s,
        "distance_km": leg1_result["distance_km"] + leg2_result["distance_km"],
        "shape": directions.concat_shapes_p5(leg1_result["shape"], leg2_result["shape"]),
        "legs": leg1_result["legs"] + leg2_result["legs"],
        "baseline_s": baseline_s,
        "delta_s": duration_s - baseline_s,
        "days": days,
    }


def _sanitize_lodging_options_by_day(
    raw: list[dict] | None, selected_place_id_by_day: dict[int, str]
) -> dict[int, list[dict]]:
    """Defensive parse of the frontend-forwarded lodging_options_by_day (see
    FinalizeRequest, main.py) — optional, map-display-only data the frontend
    already had in state from finalize-preview, carried through so the
    finalized snapshot can show EVERY option on a night, not just the one
    selected, without a second (billed) Places call. Never trusted blindly:
    any entry missing the minimum shape (place_id/name/lat/lon, all the
    right types) is dropped, and any unexpected exception here degrades to
    {} — today's behavior, only the selected lodging shows — rather than
    failing a PAID finalize over cosmetic map data.

    `selected` is computed HERE, by matching (day, place_id) against
    selected_lodging — never trusted from the frontend's own payload, since
    selected_lodging (not this list) is the actual source of truth for what
    the user picked.
    """
    result: dict[int, list[dict]] = {}
    if not isinstance(raw, list):
        return result
    try:
        for entry in raw:
            if not isinstance(entry, dict):
                continue
            day = entry.get("day")
            options = entry.get("options")
            if not isinstance(day, int) or isinstance(day, bool) or not isinstance(options, list):
                continue

            selected_place_id = selected_place_id_by_day.get(day)
            clean_options = []
            for opt in options:
                if not isinstance(opt, dict):
                    continue
                place_id, name = opt.get("place_id"), opt.get("name")
                lat, lon = opt.get("lat"), opt.get("lon")
                if not isinstance(place_id, str) or not isinstance(name, str):
                    continue
                if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
                    continue

                rating = opt.get("rating")
                user_ratings_total = opt.get("user_ratings_total")
                price_level = opt.get("price_level")
                vicinity = opt.get("vicinity")
                maps_url = opt.get("maps_url")
                clean_options.append({
                    "place_id": place_id,
                    "name": name,
                    "lat": float(lat),
                    "lon": float(lon),
                    "rating": rating if isinstance(rating, (int, float)) and not isinstance(rating, bool) else None,
                    "user_ratings_total": user_ratings_total if isinstance(user_ratings_total, int) and not isinstance(user_ratings_total, bool) else None,
                    "price_level": price_level if isinstance(price_level, int) and not isinstance(price_level, bool) else None,
                    "vicinity": vicinity if isinstance(vicinity, str) else None,
                    "maps_url": maps_url if isinstance(maps_url, str) else f"https://www.google.com/maps/place/?q=place_id:{place_id}",
                    "selected": place_id == selected_place_id,
                })
            result[day] = clean_options
    except Exception:
        return {}
    return result


async def _build_finalized_snapshot(
    trip_project_id: uuid.UUID,
    selected_lodging: list[dict] | None = None,
    lodging_options_by_day: list[dict] | None = None,
) -> dict:
    """The real detailing pipeline (Фаза 3, подшаг 2; extended in Фаза
    ночёвок, подшаг 3, to route through selected lodging). Reads the trip's
    draft_state (active option, included stops) and quiz_answers via the
    same _parse_active_selection the free preview uses, then reuses
    directions.get_route_detail (real Google Directions + day_split, same
    function /detail-route delegates to) when no lodging was picked, or
    _build_route_detail_with_lodging (same Google Directions, fixed day
    boundaries) when it was — and enrichment.enrich_route (the two-call
    Gemini pipeline /enrich-route delegates to) either way. None of these
    are duplicated here, only orchestrated.

    Self-contained on purpose: every field the frontend needs to show a
    finalized trip is copied into the returned dict, not referenced by id —
    draft_state can keep changing after this runs without affecting a
    version already written from this snapshot.

    Raises SnapshotBuildError, directions.DirectionsError, an httpx
    transport/HTTP error, or enrichment.EnrichmentError — all uncaught on
    purpose, so process_finalization's own except Exception triggers the
    refund path for any of them (this includes Google ZERO_RESULTS for a
    stop with no road access, e.g. Box Canyon — known limitation, not fixed
    here, just fails honestly instead of silently mis-routing).
    """
    trip = await trips.get_trip_by_id(trip_project_id)
    if trip is None:
        raise SnapshotBuildError(f"trip project {trip_project_id} vanished before finalization")

    origin, destination, included_stops = _parse_active_selection(trip)

    quiz_answers = trip["quiz_answers"] or {}

    planned_days_raw = quiz_answers.get("days")
    planned_days = int(planned_days_raw) if isinstance(planned_days_raw, (int, float)) else None
    flexible_days = bool(quiz_answers.get("flexible_days"))
    daily_limit_s = _daily_limit_s_from_quiz(quiz_answers)
    awake_limit_s = stops_service.awake_limit_s_for_pace(_pace_from_quiz(quiz_answers))

    trip_dates = quiz_answers.get("trip_dates")
    if not isinstance(trip_dates, str):
        trip_dates = None

    round_trip = _is_round_trip_from_quiz(quiz_answers)

    # Slow, paid external call #1 — deliberately outside any DB transaction
    # (see process_finalization's docstring). Raises on failure, uncaught.
    # `destination` here is the loop's pivot X when round_trip — see
    # _parse_active_selection / build_finalize_preview.
    if selected_lodging and round_trip:
        leg1_stops, leg2_stops = _split_included_stops_by_leg(included_stops)
        route_detail = await _build_route_detail_with_lodging_round_trip(
            origin, destination, leg1_stops, leg2_stops, selected_lodging,
            daily_limit_s=daily_limit_s, visit_s=3600, awake_limit_s=awake_limit_s,
        )
    elif selected_lodging:
        route_detail = await _build_route_detail_with_lodging(
            origin, destination, included_stops, selected_lodging,
            daily_limit_s=daily_limit_s, visit_s=3600, awake_limit_s=awake_limit_s,
        )
    elif round_trip:
        leg1_stops, leg2_stops = _split_included_stops_by_leg(included_stops)
        leg1_coords = [(s["lat"], s["lon"]) for s in leg1_stops]
        leg2_coords = [(s["lat"], s["lon"]) for s in leg2_stops]
        route_detail = await directions.get_route_detail_round_trip(
            origin, destination, leg1_coords, leg2_coords,
            daily_limit_s=daily_limit_s,
            visit_s=3600,
            planned_days=planned_days,
            flexible_days=flexible_days,
            awake_limit_s=awake_limit_s,
        )
    else:
        waypoints = [(s["lat"], s["lon"]) for s in included_stops]
        route_detail = await directions.get_route_detail(
            origin, destination, waypoints,
            daily_limit_s=daily_limit_s,
            visit_s=3600,
            planned_days=planned_days,
            flexible_days=flexible_days,
            awake_limit_s=awake_limit_s,
        )

    enrich_dto = stops_service.build_enrichment_dto(
        origin_name=trip["origin_name"] or "",
        destination_name=trip["destination_name"] or "",
        trip_dates=trip_dates,
        total_duration_s=route_detail["duration_s"],
        baseline_duration_s=route_detail["baseline_s"],
        delta_s=route_detail["delta_s"],
        distance_km=route_detail["distance_km"],
        stops=[
            {
                "id": s["id"],
                "name": s["name"],
                "category": s["category"],
                "rating": s.get("rating"),
                "review_count": s.get("review_count"),
                "detour_s": s["detour_s"],
                "duration_raw": s.get("duration"),
                "about": s.get("about"),
                "website": s.get("website"),
            }
            for s in included_stops
        ],
    )

    # Slow, paid external call #2 — same "outside any transaction" reasoning.
    # Raises enrichment.EnrichmentError on failure, uncaught.
    enrich_result = await enrichment.enrich_route(enrich_dto)
    enrich_by_id = {s["id"]: s for s in enrich_result["stops"]}

    snapshot_stops = []
    for s in included_stops:
        e = enrich_by_id.get(s["id"])
        snapshot_stops.append({
            "id": s["id"],
            "name": s["name"],
            "category": s["category"],
            "rating": s.get("rating"),
            "review_count": s.get("review_count"),
            "lat": s["lat"],
            "lon": s["lon"],
            "detour_s": s["detour_s"],
            "why": e["why"] if e else "",
            "tips": e.get("tips") if e else None,
            "dates_note": e.get("dates_note") if e else None,
            # None for one-way — round_trip's stops always carry 0/1 (see
            # find_stops_for_round_trip) — needed by the frontend to know
            # where to insert the pivot X when it draws the loop (X is never
            # itself a stop, see _parse_active_selection).
            "leg": s.get("leg"),
        })

    selected_place_id_by_day = {
        e["day"]: e["place_id"] for e in (selected_lodging or []) if isinstance(e.get("day"), int)
    }
    sanitized_lodging_by_day = _sanitize_lodging_options_by_day(lodging_options_by_day, selected_place_id_by_day)

    # Uniform day shape regardless of path taken above — "lodging" is always
    # present (dict or None), never a key that's just absent when nothing
    # was picked (no-lodging path's days, from directions.get_route_detail,
    # never had the key at all; .get() below covers that transparently).
    snapshot_days = []
    for day in route_detail["days"]:
        lodging = day.get("lodging")
        snapshot_days.append({
            "day": day["day"],
            "stop_indices": day["stop_indices"],
            "drive_s": day["drive_s"],
            "visit_s": day["visit_s"],
            "total_s": day["total_s"],
            "over_limit": day["over_limit"],
            "lodging": {
                "place_id": lodging["place_id"],
                "name": lodging["name"],
                "lat": lodging["lat"],
                "lon": lodging["lon"],
                "maps_url": f"https://www.google.com/maps/place/?q=place_id:{lodging['place_id']}",
                "rating": lodging.get("rating"),
                "vicinity": lodging.get("vicinity"),
            } if lodging else None,
            # ALL candidates shown to the user in the free preview picker for
            # this night, selected one included — [] when the frontend never
            # sent lodging_options_by_day (older client) or nothing survived
            # sanitization. Purely additive: the "lodging" field above is
            # unchanged and still the single source for the existing
            # "Ночёвка: ..." line/pin.
            "lodging_options": sanitized_lodging_by_day.get(day["day"], []),
        })

    # How the day-split ACTUALLY came out vs what the quiz asked for —
    # computed HERE, from the finished snapshot_days, not inside
    # get_route_detail/day_split. That's deliberate: get_route_detail's own
    # fits_plan only exists in the no-lodging branch above (and is never
    # read past this point — _build_route_detail_with_lodging doesn't even
    # accept planned_days/flexible_days as arguments), so it can't be the
    # source of truth for a feature that has to work the same way regardless
    # of whether lodging was picked. len(snapshot_days) is the one number
    # that's always available, from either path, after the real day-split
    # (Valhalla-boundary-driven or Google-fixed-boundary) has already run.
    actual_days = len(snapshot_days)
    over_plan = planned_days is not None and actual_days > planned_days and not flexible_days
    day_plan = {
        "requested": planned_days,
        "actual": actual_days,
        "flexible": flexible_days,
        "over_plan": over_plan,
    }

    return {
        "origin": {"name": trip["origin_name"], "lat": origin[0], "lon": origin[1]},
        "destination": {"name": trip["destination_name"], "lat": destination[0], "lon": destination[1]},
        "stops": snapshot_stops,
        "route": {
            "duration_s": route_detail["duration_s"],
            "distance_km": route_detail["distance_km"],
            "shape": route_detail["shape"],
            "legs": route_detail["legs"],
        },
        "days": snapshot_days,
        "day_plan": day_plan,
        "enrichment": {
            "overview": enrich_result["overview"],
            "warnings": enrich_result["warnings"],
            "sources": enrich_result["sources"],
        },
        "trip_dates": trip_dates,
        "finalized_at": datetime.now(timezone.utc).isoformat(),
        "round_trip": round_trip,
    }


async def process_finalization(
    job_id: uuid.UUID,
    selected_lodging: list[dict] | None = None,
    lodging_options_by_day: list[dict] | None = None,
) -> None:
    """Background task (FastAPI BackgroundTasks) — runs after the charging
    transaction in start_finalization has already committed and the HTTP
    response has been sent. Three short transactions, not one long one
    spanning the "real work": that work will eventually be slow external API
    calls (Google/Gemini, подшаг 2), which have no business holding a DB
    transaction open.

    selected_lodging/lodging_options_by_day come straight from the
    /trips/{id}/finalize request body (main.py) that scheduled this task —
    not persisted anywhere, purely passed through BackgroundTasks' own
    arguments. An idempotency replay or in-flight-job return never
    re-schedules this task (see FinalizationJob.is_new's docstring), so a
    request's selected_lodging/lodging_options_by_day only ever matter for
    the ONE call that actually created the job; the same is already true of
    idempotency_key today, this just extends it.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        job_row = await conn.fetchrow(
            "SELECT trip_project_id, user_id FROM app.finalization_jobs WHERE id = $1",
            job_id,
        )
        if job_row is None:
            return  # job vanished (shouldn't happen) — nothing to process
        trip_project_id = job_row["trip_project_id"]
        user_id = job_row["user_id"]

        await conn.execute(
            "UPDATE app.finalization_jobs SET status = 'processing' WHERE id = $1",
            job_id,
        )

    try:
        snapshot = await _build_finalized_snapshot(trip_project_id, selected_lodging, lodging_options_by_day)

        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                version_row = await conn.fetchrow(
                    """
                    INSERT INTO app.trip_versions (trip_project_id, version_type, snapshot)
                    VALUES ($1, 'finalized', $2::jsonb)
                    RETURNING id
                    """,
                    trip_project_id, json.dumps(snapshot),
                )
                version_id = version_row["id"]

                await conn.execute(
                    "UPDATE app.finalization_jobs SET status = 'done', trip_version_id = $1 WHERE id = $2",
                    version_id, job_id,
                )
                await conn.execute(
                    """
                    UPDATE app.trip_projects
                    SET status = 'finalized', finalized_version_id = $1
                    WHERE id = $2
                    """,
                    version_id, trip_project_id,
                )
    except Exception as e:
        # Paid, didn't deliver -> refund is mandatory, not best-effort. Own
        # transaction, separate from whatever failed above.
        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute(
                    "UPDATE app.finalization_jobs SET status = 'failed', error = $1 WHERE id = $2",
                    str(e), job_id,
                )
                await conn.execute(
                    "UPDATE app.credit_accounts SET balance = balance + 1 WHERE user_id = $1",
                    user_id,
                )
                await conn.execute(
                    "INSERT INTO app.credit_ledger (user_id, amount, reason) VALUES ($1, 1, $2)",
                    user_id, f"refund:{trip_project_id}",
                )
                await conn.execute(
                    "UPDATE app.trip_projects SET status = 'draft' WHERE id = $1",
                    trip_project_id,
                )


@dataclass
class JobStatus:
    status: str
    trip_version_id: uuid.UUID | None
    error: str | None


async def get_job_status(user_id: uuid.UUID, job_id: uuid.UUID) -> JobStatus | None:
    """None if the job doesn't exist or belongs to someone else — same
    indistinguishable-404 reasoning as everywhere else."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT status, trip_version_id, error FROM app.finalization_jobs WHERE id = $1 AND user_id = $2",
            job_id, user_id,
        )
    return JobStatus(status=row["status"], trip_version_id=row["trip_version_id"], error=row["error"]) if row else None


async def get_balance(user_id: uuid.UUID) -> int:
    """Plain unlocked read, for display only — never used to decide whether a
    charge can proceed (start_finalization does its own FOR UPDATE read for
    that, unchanged from подшаг 1). 0 if the row doesn't exist rather than
    raising — shouldn't happen post-signup (claim_session_for_google_user
    always creates one), but a missing account reads the same as an empty one
    here, not an error."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        balance = await conn.fetchval(
            "SELECT balance FROM app.credit_accounts WHERE user_id = $1", user_id
        )
    return balance if balance is not None else 0


async def is_first_finalize(user_id: uuid.UUID) -> bool:
    """True if this user has exactly one finalized trip_version total, right
    now — gates the one-time "this one's on us" welcome modal (подшаг 3),
    shown once right after a user's first successful Finalize.

    Counts trip_versions, not credit_ledger's 'finalize:%' entries: a ledger
    charge happens on every attempt, including ones that later fail and get
    refunded, so it would overcount. A trip_versions row only ever exists for
    a run that actually completed — the right signal for "has this user ever
    seen a finished result before."
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        count = await conn.fetchval(
            """
            SELECT count(*) FROM app.trip_versions tv
            JOIN app.trip_projects tp ON tp.id = tv.trip_project_id
            WHERE tp.owner_user_id = $1 AND tv.version_type = 'finalized'
            """,
            user_id,
        )
    return count == 1


async def get_finalized_snapshot(
    session_id: uuid.UUID, user_id: uuid.UUID | None, trip_id: uuid.UUID
) -> dict | None:
    """None if the trip doesn't exist, doesn't belong to the caller (same
    session/owner check as trips.get_trip_for_session), or has never been
    finalized (finalized_version_id IS NULL) — same indistinguishable-404
    reasoning used everywhere else in this app: never confirm to the caller
    which of those three it was.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT tv.snapshot
            FROM app.trip_projects tp
            JOIN app.trip_versions tv ON tv.id = tp.finalized_version_id
            WHERE tp.id = $1 AND (tp.anonymous_session_id = $2 OR tp.owner_user_id = $3)
            """,
            trip_id, session_id, user_id,
        )
    return json.loads(row["snapshot"]) if row else None
