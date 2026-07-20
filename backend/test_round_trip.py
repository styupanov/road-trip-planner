import uuid
from unittest.mock import AsyncMock, patch

import httpx
import polyline as polyline_lib
import pytest

import directions
import finalize
import routing
from services import stops as stops_service

pytestmark = pytest.mark.anyio


def _p5(points: list[tuple[float, float]]) -> str:
    return polyline_lib.encode(points, 5)


def _stop(id_, detour_s, to_poi_s=0):
    return {"id": id_, "name": f"Stop {id_}", "detour_s": detour_s, "to_poi_s": to_poi_s}


# --- (b) cross-leg POI dedup: services.stops._dedupe_round_trip_stops -------
# A round trip searches each leg's corridor independently, so the same POI
# can turn up as a candidate on BOTH legs (roads run close together, or the
# return leg retraces part of the outbound one) — dedup keeps it on
# whichever leg gives it the smaller detour, drops it from the other.

def test_dedupe_keeps_shared_poi_on_leg_with_smaller_detour():
    leg1 = [_stop(1, detour_s=500), _stop(2, detour_s=900)]
    leg2 = [_stop(2, detour_s=300), _stop(3, detour_s=200)]

    out1, out2 = stops_service._dedupe_round_trip_stops(leg1, leg2)

    assert [s["id"] for s in out1] == [1]  # stop 2 lost to leg2 (300 < 900)
    assert [s["id"] for s in out2] == [2, 3]


def test_dedupe_ties_go_to_leg1():
    leg1 = [_stop(5, detour_s=400)]
    leg2 = [_stop(5, detour_s=400)]

    out1, out2 = stops_service._dedupe_round_trip_stops(leg1, leg2)

    assert [s["id"] for s in out1] == [5]
    assert out2 == []


def test_dedupe_leaves_non_shared_stops_untouched():
    leg1 = [_stop(1, detour_s=100)]
    leg2 = [_stop(2, detour_s=100)]

    out1, out2 = stops_service._dedupe_round_trip_stops(leg1, leg2)

    assert out1 == leg1
    assert out2 == leg2


# --- (a) two independent legs, concatenated: build_route_through_round_trip -

_LEG1_POINTS = [(39.0, -105.0), (39.05, -105.05)]
_LEG2_POINTS = [(39.05, -105.05), (38.0, -106.0)]  # starts where leg1 ends (the pivot)

_LEG1_THROUGH = {
    "total_s": 5000, "distance_km": 80.0,
    "route_shape": polyline_lib.encode(_LEG1_POINTS, 6),
    "legs": [
        {"from_index": 0, "to_index": 1, "duration_s": 2000, "distance_km": 30.0},
        {"from_index": 1, "to_index": 2, "duration_s": 3000, "distance_km": 50.0},  # -> pivot
    ],
}
_LEG2_THROUGH = {
    "total_s": 4000, "distance_km": 70.0,
    "route_shape": polyline_lib.encode(_LEG2_POINTS, 6),
    "legs": [
        {"from_index": 0, "to_index": 1, "duration_s": 1500, "distance_km": 20.0},  # pivot -> first leg2 stop
        {"from_index": 1, "to_index": 2, "duration_s": 2500, "distance_km": 50.0},  # -> origin
    ],
}


async def test_build_route_through_round_trip_calls_valhalla_twice_and_merges_pivot():
    """Plечо 1 (A->X) and плечо 2 (X->A) are two independent
    build_route_through calls -- the second is free to land on a different
    real road than the first (never forced to retrace). The two legs
    adjacent to the pivot (leg1's final hop INTO it, leg2's first hop OUT of
    it) collapse into ONE summed leg, so the pivot never gets its own index
    and the result is already day-split-ready (stop_count+1 legs), exactly
    like one-way build_route_through's own convention."""
    with patch(
        "services.stops.build_route_through",
        new=AsyncMock(side_effect=[_LEG1_THROUGH, _LEG2_THROUGH]),
    ) as mock_build:
        result = await stops_service.build_route_through_round_trip(
            origin=(39.0, -105.0), pivot=(38.0, -106.0),
            leg1_stop_coords=[(39.02, -105.02)], leg2_stop_coords=[(37.9, -106.1)],
        )

    assert mock_build.call_count == 2
    leg1_call, leg2_call = mock_build.call_args_list
    assert leg1_call.args[0] == (39.0, -105.0) and leg1_call.args[1] == (38.0, -106.0)
    assert leg2_call.args[0] == (38.0, -106.0) and leg2_call.args[1] == (39.0, -105.0)

    # 1 leg1 stop + 1 leg2 stop -> stop_count=2 -> stop_count+1=3 legs, pivot merged.
    assert len(result["legs"]) == 3
    assert result["legs"][0] == {"from_index": 0, "to_index": 1, "duration_s": 2000, "distance_km": 30.0}
    pivot_leg = result["legs"][1]
    assert pivot_leg["from_index"] == 1 and pivot_leg["to_index"] == 2
    assert pivot_leg["duration_s"] == 3000 + 1500  # leg1's into-pivot + leg2's out-of-pivot, summed
    assert pivot_leg["distance_km"] == 50.0 + 20.0
    assert result["legs"][2] == {"from_index": 2, "to_index": 3, "duration_s": 2500, "distance_km": 50.0}

    assert result["total_s"] == 5000 + 4000
    assert result["distance_km"] == 80.0 + 70.0

    # Shapes concatenated with the duplicate pivot point dropped: 2+2-1=3 points.
    assert len(polyline_lib.decode(result["route_shape"], 6)) == 3


# --- (c) day-split crosses the pivot as ONE continuous sequence -------------
# directions.get_route_detail_round_trip

async def test_get_route_detail_round_trip_treats_pivot_as_ordinary_waypoint():
    """day_split.py is never told a round trip exists: the pivot is made an
    ordinary, non-day-breaking waypoint purely by merging the two Directions
    legs adjacent to it into one summed hop before day_split ever sees the
    list. daily_limit_s is picked so the split lands exactly on the leg1/leg2
    boundary -- day 2 then has to absorb the pivot crossing mid-drive,
    proving the whole loop is walked as ONE sequence, not two independently
    split legs."""
    leg1_result = {
        "duration_s": 14400, "distance_km": 200.0, "shape": _p5([(0.0, 0.0), (1.0, 1.0)]),
        "legs": [
            {"duration_s": 10000, "distance_km": 150.0},  # origin -> leg1 stop
            {"duration_s": 4400, "distance_km": 50.0},    # leg1 stop -> pivot
        ],
    }
    leg2_result = {
        "duration_s": 14000, "distance_km": 190.0, "shape": _p5([(1.0, 1.0), (0.0, 0.0)]),
        "legs": [
            {"duration_s": 4000, "distance_km": 40.0},    # pivot -> leg2 stop
            {"duration_s": 10000, "distance_km": 150.0},  # leg2 stop -> origin
        ],
    }
    leg1_baseline = {"duration_s": 13000, "distance_km": 195.0, "shape": "b1", "legs": []}
    leg2_baseline = {"duration_s": 12500, "distance_km": 185.0, "shape": "b2", "legs": []}

    async def fake_get_directions(origin, destination, waypoints=None):
        if (origin, destination) == ((0.0, 0.0), (1.0, 1.0)):
            return leg1_result if waypoints else leg1_baseline
        return leg2_result if waypoints else leg2_baseline

    with patch("directions.get_directions", new=AsyncMock(side_effect=fake_get_directions)):
        result = await directions.get_route_detail_round_trip(
            origin=(0.0, 0.0), pivot=(1.0, 1.0),
            leg1_stops=[(0.5, 0.5)], leg2_stops=[(1.5, 1.5)],
            daily_limit_s=14400, visit_s=3600,
        )

    # Pivot merged into ONE hop: stop_count=2 -> exactly 3 legs, not 4.
    assert len(result["legs"]) == 3
    assert result["legs"][0]["duration_s"] == 10000        # origin -> leg1 stop
    assert result["legs"][1]["duration_s"] == 4400 + 4000  # leg1 stop -> pivot -> leg2 stop, summed
    assert result["legs"][2]["duration_s"] == 10000        # leg2 stop -> origin

    # day_split sees ONE continuous sequence: day 1 closes after the leg1
    # stop (adding the pivot-crossing hop would blow the daily limit), and
    # day 2 absorbs the pivot crossing entirely inside its own drive_s,
    # never breaking a day AT the pivot itself.
    assert result["days"] == [
        {"day": 1, "stop_indices": [0], "drive_s": 10000, "visit_s": 3600, "total_s": 13600, "over_limit": False},
        {"day": 2, "stop_indices": [1], "drive_s": 18400, "visit_s": 3600, "total_s": 22000, "over_limit": True},
    ]

    assert result["duration_s"] == 14400 + 14000
    assert result["distance_km"] == 200.0 + 190.0
    assert result["baseline_s"] == 13000 + 12500
    assert result["delta_s"] == result["duration_s"] - result["baseline_s"]


# --- finalize.py: quiz flag + stop/leg splitting helpers --------------------

def test_is_round_trip_from_quiz():
    assert finalize._is_round_trip_from_quiz({"trip": "Туда и обратно"}) is True
    assert finalize._is_round_trip_from_quiz({"trip": "В одну сторону"}) is False
    assert finalize._is_round_trip_from_quiz(None) is False
    assert finalize._is_round_trip_from_quiz({}) is False


def test_split_included_stops_by_leg():
    s0 = {"id": 1, "leg": 0}
    s1 = {"id": 2, "leg": 1}
    s2 = {"id": 3}  # missing tag -> defaults to leg 0, never silently dropped

    leg1, leg2 = finalize._split_included_stops_by_leg([s0, s1, s2])

    assert leg1 == [s0, s2]
    assert leg2 == [s1]


# --- finalize.py: free preview ends the loop back at ORIGIN, not the pivot --

def _fake_trip(draft_state: dict, quiz_answers: dict) -> dict:
    return {
        "id": uuid.uuid4(),
        "origin_name": "Денвер",
        "destination_name": "Дуранго",
        "quiz_answers": quiz_answers,
        "draft_state": draft_state,
    }


def _round_trip_draft_state(leg1_stop: dict, leg2_stop: dict) -> dict:
    return {
        "version": 1,
        "options": [{
            "index": 0, "duration_s": 15000, "distance_km": 150.0,
            "route_shape": "fake_shape", "through_shape": None, "total_s": None, "delta_s": None,
            "stops": [leg1_stop, leg2_stop], "candidates_found": 2, "avg_rating": None,
            "top_stops": [], "near_endpoints": [], "unreachable": [],
        }],
        "activeOptionIndex": 0,
        "includedByOption": [[0, [leg1_stop["id"], leg2_stop["id"]]]],
        "routeThroughByOption": [],
        "routeOrigin": {"lat": 39.7392, "lng": -104.9903},
        "routeDest": {"lat": 37.2753, "lng": -107.8801},  # the pivot X, not where the trip ends
    }


async def test_build_finalize_preview_round_trip_uses_split_legs_and_ends_at_origin():
    leg1_stop = _stop(1, detour_s=600, to_poi_s=1000)
    leg1_stop.update(name="Stop 1", lat=39.1, lon=-105.1, leg=0)
    leg2_stop = _stop(2, detour_s=600, to_poi_s=90000)
    leg2_stop.update(name="Stop 2", lat=37.5, lon=-107.5, leg=1)

    trip = _fake_trip(
        _round_trip_draft_state(leg1_stop, leg2_stop),
        quiz_answers={"drive": "не важно", "trip": "Туда и обратно"},
    )
    fake_through = {
        "legs": [
            {"duration_s": 5000, "distance_km": 50.0},
            {"duration_s": 5000, "distance_km": 50.0},
            {"duration_s": 5000, "distance_km": 50.0},
        ],
        "total_s": 15000, "distance_km": 150.0, "route_shape": "valhalla_rt_shape",
    }

    with patch(
        "services.stops.build_route_through_round_trip", new=AsyncMock(return_value=fake_through)
    ) as mock_rt, patch("accommodations.find_nearest_lodging", new=AsyncMock(return_value=[])):
        preview = await finalize.build_finalize_preview(trip)

    # Split by "leg" tag, NOT plain build_route_through -- one call, the round-trip builder.
    mock_rt.assert_called_once()
    args = mock_rt.call_args.args
    assert args[2] == [(39.1, -105.1)]   # leg1 coords
    assert args[3] == [(37.5, -107.5)]   # leg2 coords

    # Only one day (daily_limit_s "не важно" = 28800s, drive totals well under
    # it) -> the single day is also the last day, so its end_point must be
    # ORIGIN, not routeDest (the pivot the trip only passes through).
    assert len(preview["days"]) == 1
    assert preview["days"][0]["end_point"] == {"lat": 39.7392, "lon": -104.9903, "near_stop_name": None}


# --- finalize.py: fixed-lodging path, a day straddling the leg1/leg2 pivot --

async def test_build_route_detail_with_lodging_round_trip_day_straddles_pivot():
    """A single day CAN legitimately contain both a trailing leg1 stop and a
    leading leg2 stop, since day_split's greedy algorithm has no notion of a
    leg boundary. This proves the stop-by-stop walk correctly attributes
    BOTH legs' drive time to that one day, instead of losing/duplicating the
    pivot-crossing hop."""
    leg1_stops = [{"id": 1, "lat": 39.1, "lon": -105.1}]
    leg2_stops = [{"id": 2, "lat": 37.5, "lon": -107.5}]

    fake_through = {
        "legs": [
            {"duration_s": 1000, "distance_km": 10.0},
            {"duration_s": 500, "distance_km": 5.0},
            {"duration_s": 800, "distance_km": 8.0},
        ],
        "total_s": 2300, "distance_km": 23.0, "route_shape": "valhalla_rt_shape",
    }

    leg1_result = {
        "duration_s": 4000, "distance_km": 50.0, "shape": _p5([(0.0, 0.0), (1.0, 1.0)]),
        "legs": [
            {"duration_s": 3000, "distance_km": 40.0},  # origin -> leg1 stop
            {"duration_s": 1000, "distance_km": 10.0},  # leg1 stop -> pivot
        ],
    }
    leg2_result = {
        "duration_s": 4700, "distance_km": 60.0, "shape": _p5([(1.0, 1.0), (0.0, 0.0)]),
        "legs": [
            {"duration_s": 1200, "distance_km": 15.0},  # pivot -> leg2 stop
            {"duration_s": 3500, "distance_km": 45.0},  # leg2 stop -> origin
        ],
    }
    leg1_baseline = {"duration_s": 3800, "distance_km": 48.0, "shape": "b1", "legs": []}
    leg2_baseline = {"duration_s": 4500, "distance_km": 58.0, "shape": "b2", "legs": []}

    calls: list[tuple] = []

    async def fake_get_directions(origin, destination, waypoints=None):
        calls.append((origin, destination, waypoints))
        if (origin, destination) == ((0.0, 0.0), (1.0, 1.0)):
            return leg1_result if waypoints else leg1_baseline
        return leg2_result if waypoints else leg2_baseline

    with patch(
        "services.stops.build_route_through_round_trip", new=AsyncMock(return_value=fake_through)
    ), patch("directions.get_directions", new=AsyncMock(side_effect=fake_get_directions)):
        result = await finalize._build_route_detail_with_lodging_round_trip(
            origin=(0.0, 0.0), pivot=(1.0, 1.0),
            leg1_stops=leg1_stops, leg2_stops=leg2_stops,
            selected_lodging=[], daily_limit_s=100000, visit_s=3600, awake_limit_s=100000,
        )

    # Generous daily_limit_s -> day_split puts both stops in one day, which
    # straddles the pivot (global index 0 is leg1's, index 1 is leg2's).
    assert len(result["days"]) == 1
    day = result["days"][0]
    assert day["stop_indices"] == [0, 1]
    # Both legs' drive time is captured -- leg1's full 2 hops (into stop,
    # into pivot) PLUS leg2's full 2 hops (out of pivot, into origin).
    assert day["drive_s"] == (3000 + 1000) + (1200 + 3500)
    assert day["lodging"] is None

    assert result["duration_s"] == 4000 + 4700
    assert result["distance_km"] == 50.0 + 60.0
    assert result["baseline_s"] == 3800 + 4500

    # Two independent Directions calls, one per leg -- never a single
    # origin-equals-destination call.
    waypoint_calls = [c for c in calls if c[2]]
    assert len(waypoint_calls) == 2
    leg1_waypoint_call = next(c for c in waypoint_calls if c[0] == (0.0, 0.0))
    leg2_waypoint_call = next(c for c in waypoint_calls if c[0] == (1.0, 1.0))
    assert leg1_waypoint_call[2] == [(39.1, -105.1)]
    assert leg2_waypoint_call[2] == [(37.5, -107.5)]


async def test_build_route_detail_with_lodging_round_trip_lodging_after_pivot_goes_on_leg2():
    """A night picked for a day that has already reached the pivot by day's
    end can't be "at the pivot" itself -- it has to sit on leg2's route, even
    if that day's own stop happens to be on leg1."""
    leg1_stops = [{"id": 1, "lat": 39.1, "lon": -105.1}]
    leg2_stops: list[dict] = []  # nothing after the pivot but the drive home

    fake_through = {
        "legs": [
            {"duration_s": 1000, "distance_km": 10.0},
            {"duration_s": 500, "distance_km": 5.0},
        ],
        "total_s": 1500, "distance_km": 15.0, "route_shape": "valhalla_rt_shape",
    }

    leg1_result = {
        "duration_s": 4000, "distance_km": 50.0, "shape": _p5([(0.0, 0.0), (1.0, 1.0)]),
        "legs": [
            {"duration_s": 3000, "distance_km": 40.0},  # origin -> leg1 stop
            {"duration_s": 1000, "distance_km": 10.0},  # leg1 stop -> pivot
        ],
    }
    leg2_result = {
        "duration_s": 2000, "distance_km": 25.0, "shape": _p5([(1.0, 1.0), (0.0, 0.0)]),
        "legs": [
            {"duration_s": 2000, "distance_km": 25.0},  # pivot -> lodging -> origin, one hop each
        ],
    }
    leg1_baseline = {"duration_s": 3800, "distance_km": 48.0, "shape": "b1", "legs": []}
    leg2_baseline = {"duration_s": 1900, "distance_km": 24.0, "shape": "b2", "legs": []}

    calls: list[tuple] = []

    async def fake_get_directions(origin, destination, waypoints=None):
        calls.append((origin, destination, waypoints))
        if (origin, destination) == ((0.0, 0.0), (1.0, 1.0)):
            return leg1_result if waypoints else leg1_baseline
        return leg2_result if waypoints else leg2_baseline

    selected_lodging = [{"day": 1, "place_id": "p1", "lat": 1.2, "lon": 1.3, "name": "Pivot Inn"}]

    with patch(
        "services.stops.build_route_through_round_trip", new=AsyncMock(return_value=fake_through)
    ), patch("directions.get_directions", new=AsyncMock(side_effect=fake_get_directions)):
        await finalize._build_route_detail_with_lodging_round_trip(
            origin=(0.0, 0.0), pivot=(1.0, 1.0),
            leg1_stops=leg1_stops, leg2_stops=leg2_stops,
            selected_lodging=selected_lodging, daily_limit_s=100000, visit_s=3600, awake_limit_s=100000,
        )

    waypoint_calls = [c for c in calls if c[2]]
    leg1_waypoint_call = next(c for c in waypoint_calls if c[0] == (0.0, 0.0))
    leg2_waypoint_call = next(c for c in waypoint_calls if c[0] == (1.0, 1.0))
    # The lodging pick lands on leg2's waypoint list, not leg1's, even though
    # day 1's only actual stop is a leg1 stop.
    assert leg1_waypoint_call[2] == [(39.1, -105.1)]
    assert leg2_waypoint_call[2] == [(1.2, 1.3)]


# --- return-leg dissimilarity: services.stops._select_dissimilar_return_leg -
# Round trip's return leg (X->A) should, where possible, take a DIFFERENT
# road than the outbound leg (A->X) -- measured by shared OSM way_id, not
# geometry (parallel carriageways of the same road share a way_id; a
# geometric comparison would falsely call them "different").

def test_select_dissimilar_return_leg_picks_lowest_overlap_within_thresholds():
    fastest = {"duration_s": 1000, "shape": "s0"}
    similar = {"duration_s": 1050, "shape": "s1"}        # overlap 0.9 -> too similar, rejected
    dissimilar_ok = {"duration_s": 1200, "shape": "s2"}  # overlap 0.3, detour x1.2 -> passes both bars
    too_slow = {"duration_s": 1400, "shape": "s3"}       # overlap 0.1 but detour x1.4 -> too slow, rejected

    forward_ways = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
    candidates = [fastest, similar, dissimilar_ok, too_slow]
    candidate_ways = [
        {1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
        {1, 2, 3, 4, 5, 6, 7, 8, 9, 11},
        {1, 2, 3, 11, 12, 13, 14, 15, 16, 17},
        {1, 20, 21, 22, 23, 24, 25, 26, 27, 28},
    ]

    chosen = stops_service._select_dissimilar_return_leg(forward_ways, candidates, candidate_ways)

    assert chosen is dissimilar_ok


def test_select_dissimilar_return_leg_falls_back_to_fastest_when_none_qualifies():
    """The only real alternative is 90% the same road as the outbound leg --
    not different enough to be worth it, so the fastest option wins by
    default rather than forcing a barely-different detour."""
    fastest = {"duration_s": 1000, "shape": "s0"}
    similar = {"duration_s": 1050, "shape": "s1"}  # overlap 0.9 -> rejected

    forward_ways = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
    candidates = [fastest, similar]
    candidate_ways = [
        {1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
        {1, 2, 3, 4, 5, 6, 7, 8, 9, 11},
    ]

    chosen = stops_service._select_dissimilar_return_leg(forward_ways, candidates, candidate_ways)

    assert chosen is fastest


def test_select_dissimilar_return_leg_empty_forward_ways_falls_back():
    """trace_attributes failed for the FORWARD leg -- nothing to compare
    against, so fall back immediately without even looking at candidates."""
    fastest = {"duration_s": 1000, "shape": "s0"}
    other = {"duration_s": 1100, "shape": "s1"}

    chosen = stops_service._select_dissimilar_return_leg(set(), [fastest, other], [{1, 2}, {3, 4}])

    assert chosen is fastest


def test_select_dissimilar_return_leg_skips_candidate_with_empty_ways():
    """trace_attributes failed for ONE candidate (empty way_id set) -- that
    candidate is skipped rather than treated as "0% overlap, pick me"."""
    fastest = {"duration_s": 1000, "shape": "s0"}
    failed_trace = {"duration_s": 1100, "shape": "s1"}  # would win on overlap, but its trace failed

    forward_ways = {1, 2, 3}
    candidates = [fastest, failed_trace]
    candidate_ways = [{1, 2, 3}, set()]

    chosen = stops_service._select_dissimilar_return_leg(forward_ways, candidates, candidate_ways)

    assert chosen is fastest


# --- routing.way_ids_for_shape: the trace_attributes wrapper itself --------

class _FakeResponse:
    def __init__(self, json_data):
        self._json_data = json_data

    def raise_for_status(self):
        pass

    def json(self):
        return self._json_data


class _FakeAsyncClient:
    def __init__(self, response=None, error: Exception | None = None):
        self._response = response
        self._error = error

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None, timeout=None):
        if self._error:
            raise self._error
        return self._response


async def test_way_ids_for_shape_extracts_way_ids_from_edges():
    fake_response = _FakeResponse({"edges": [{"way_id": 111}, {"way_id": 222}, {"length": 5}]})

    with patch("routing.httpx.AsyncClient", return_value=_FakeAsyncClient(response=fake_response)):
        result = await routing.way_ids_for_shape("fake_shape")

    assert result == {111, 222}


async def test_way_ids_for_shape_returns_empty_set_on_http_error():
    """Valhalla down/unreachable -- fall back to "comparison impossible", never
    raise and sink the whole round-trip draft over it."""
    with patch(
        "routing.httpx.AsyncClient",
        return_value=_FakeAsyncClient(error=httpx.ConnectError("no valhalla")),
    ):
        result = await routing.way_ids_for_shape("fake_shape")

    assert result == set()


# --- finalize inherits the draft's chosen return-leg waypoints -------------
# Google (finalize) has no way_id concept at all -- the dissimilarity choice
# made at draft time must reach finalize purely through which POIs/waypoints
# were already selected for leg2, never by re-running the way_id logic.

async def test_finalize_round_trip_never_calls_way_id_dissimilarity_logic():
    leg1_stops = [{"id": 1, "lat": 39.1, "lon": -105.1}]
    leg2_stops = [{"id": 2, "lat": 37.5, "lon": -107.5}]

    fake_through = {
        "legs": [
            {"duration_s": 1000, "distance_km": 10.0},
            {"duration_s": 500, "distance_km": 5.0},
            {"duration_s": 800, "distance_km": 8.0},
        ],
        "total_s": 2300, "distance_km": 23.0, "route_shape": "valhalla_rt_shape",
    }
    leg1_result = {
        "duration_s": 4000, "distance_km": 50.0, "shape": _p5([(0.0, 0.0), (1.0, 1.0)]),
        "legs": [{"duration_s": 3000, "distance_km": 40.0}, {"duration_s": 1000, "distance_km": 10.0}],
    }
    leg2_result = {
        "duration_s": 4700, "distance_km": 60.0, "shape": _p5([(1.0, 1.0), (0.0, 0.0)]),
        "legs": [{"duration_s": 1200, "distance_km": 15.0}, {"duration_s": 3500, "distance_km": 45.0}],
    }
    leg1_baseline = {"duration_s": 3800, "distance_km": 48.0, "shape": "b1", "legs": []}
    leg2_baseline = {"duration_s": 4500, "distance_km": 58.0, "shape": "b2", "legs": []}

    async def fake_get_directions(origin, destination, waypoints=None):
        if (origin, destination) == ((0.0, 0.0), (1.0, 1.0)):
            return leg1_result if waypoints else leg1_baseline
        return leg2_result if waypoints else leg2_baseline

    with patch(
        "services.stops.build_route_through_round_trip", new=AsyncMock(return_value=fake_through)
    ), patch(
        "directions.get_directions", new=AsyncMock(side_effect=fake_get_directions)
    ), patch(
        "routing.way_ids_for_shape",
        new=AsyncMock(side_effect=AssertionError("way_id dissimilarity logic must not run at finalize time")),
    ):
        result = await finalize._build_route_detail_with_lodging_round_trip(
            origin=(0.0, 0.0), pivot=(1.0, 1.0),
            leg1_stops=leg1_stops, leg2_stops=leg2_stops,
            selected_lodging=[], daily_limit_s=100000, visit_s=3600, awake_limit_s=100000,
        )

    # Completed without ever touching way_ids_for_shape -- the return leg's
    # waypoints (leg2_stops) came from the draft's already-made choice.
    assert len(result["days"]) == 1


# --- wired end to end: services.stops.compare_routes(round_trip=True) ------

async def test_compare_routes_round_trip_uses_dissimilar_return_leg_not_fastest():
    """The fastest return candidate retraces the SAME road as the outbound
    leg (overlap 1.0) -- compare_routes' round-trip branch must pick the
    genuinely different alternate instead, and that choice must be what
    POI search and the through-route actually get built against."""
    leg1_shape = polyline_lib.encode([(0.0, 0.0), (1.0, 1.0)], 6)
    leg2_fast_shape = polyline_lib.encode([(1.0, 1.0), (0.0, 0.0)], 6)
    leg2_alt_shape = polyline_lib.encode([(1.0, 1.0), (0.5, 0.5), (0.0, 0.0)], 6)

    leg1_options = [{"duration_s": 1000, "distance_km": 10.0, "shape": leg1_shape}]
    leg2_options = [
        {"duration_s": 900, "distance_km": 9.0, "shape": leg2_fast_shape},   # same road as leg1 -> should be rejected
        {"duration_s": 1000, "distance_km": 11.0, "shape": leg2_alt_shape},  # different road, within detour ratio
    ]
    ways_by_shape = {
        leg1_shape: {1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
        leg2_fast_shape: {1, 2, 3, 4, 5, 6, 7, 8, 9, 10},   # identical to leg1 -> overlap 1.0
        leg2_alt_shape: {20, 21, 22, 23, 24, 25, 26, 27, 28, 29},  # overlap 0.0
    }

    empty_stops_result = {
        "leg1": {"stops": [], "candidates_found": 0, "near_endpoints": [], "unreachable": []},
        "leg2": {"stops": [], "candidates_found": 0, "near_endpoints": [], "unreachable": []},
    }
    fake_through = {"total_s": 1900, "distance_km": 20.0, "route_shape": "through_shape", "legs": []}

    find_stops_calls: list[dict] = []

    async def fake_find_stops_for_round_trip(**kwargs):
        find_stops_calls.append(kwargs)
        return empty_stops_result

    with patch(
        "routing.get_route_alternates", new=AsyncMock(side_effect=[leg1_options, leg2_options])
    ), patch(
        "routing.way_ids_for_shape", new=AsyncMock(side_effect=lambda shape: ways_by_shape[shape])
    ), patch(
        "services.stops.find_stops_for_round_trip", new=AsyncMock(side_effect=fake_find_stops_for_round_trip)
    ), patch(
        "services.stops.build_route_through_round_trip", new=AsyncMock(return_value=fake_through)
    ):
        result = await stops_service.compare_routes(
            origin=(0.0, 0.0), destination=(1.0, 1.0), categories=[], max_detour_s=1800, round_trip=True,
        )

    assert len(result["options"]) == 1
    # POI search for leg2 ran against the DISSIMILAR shape, not the fastest one.
    assert find_stops_calls[0]["leg2_shape"] == leg2_alt_shape
    assert result["options"][0]["duration_s"] == 1000 + 1000  # leg1 + the chosen (not fastest) leg2
