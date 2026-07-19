import pytest

from day_split import split_into_days


def leg(duration_s):
    return {"duration_s": duration_s}


def test_route_fits_in_one_day():
    # 3 short stops + short final leg, well under an 8h day.
    legs = [leg(1000), leg(1000), leg(1000), leg(1000)]
    days = split_into_days(legs, stop_count=3, daily_limit_s=28800, visit_s=3600)

    assert len(days) == 1
    assert days[0]["stop_indices"] == [0, 1, 2]
    assert days[0]["drive_s"] == 4000
    assert days[0]["visit_s"] == 3 * 3600
    assert days[0]["total_s"] == 4000 + 3 * 3600
    assert days[0]["over_limit"] is False


def test_exact_boundary_does_not_split_but_next_stop_does():
    # visit_s=3600, leg=3600 -> each stop costs exactly 7200s. 4 stops land
    # exactly on a 28800s limit (no split); a 5th would push past it. Final
    # leg is 0 here so it doesn't itself push the day over the boundary being
    # tested — that's covered separately (the final leg always lands on
    # whichever day is open, even over_limit, see the "kept not lost" test).
    legs = [leg(3600)] * 4 + [leg(0)]
    days = split_into_days(legs, stop_count=4, daily_limit_s=28800, visit_s=3600)

    assert len(days) == 1
    assert days[0]["stop_indices"] == [0, 1, 2, 3]
    assert days[0]["drive_s"] == 4 * 3600
    assert days[0]["over_limit"] is False

    legs5 = [leg(3600)] * 5 + [leg(100)]
    days5 = split_into_days(legs5, stop_count=5, daily_limit_s=28800, visit_s=3600)

    assert len(days5) == 2
    assert days5[0]["stop_indices"] == [0, 1, 2, 3]
    assert days5[1]["stop_indices"] == [4]
    assert days5[1]["over_limit"] is False


def test_single_leg_longer_than_limit_is_kept_not_lost():
    # The leg to stop 0 alone is longer than the daily limit — it must still
    # become its own (over-limit) day, not be dropped or loop forever.
    legs = [leg(40000), leg(500)]
    days = split_into_days(legs, stop_count=1, daily_limit_s=28800, visit_s=3600)

    assert len(days) == 1
    assert days[0]["stop_indices"] == [0]
    assert days[0]["drive_s"] == 40000 + 500
    assert days[0]["over_limit"] is True


def test_empty_stops_is_one_day_origin_to_dest():
    legs = [leg(12345)]
    days = split_into_days(legs, stop_count=0, daily_limit_s=28800, visit_s=3600)

    assert len(days) == 1
    assert days[0]["stop_indices"] == []
    assert days[0]["drive_s"] == 12345
    assert days[0]["visit_s"] == 0
    assert days[0]["total_s"] == 12345
    assert days[0]["over_limit"] is False


def test_many_short_stops_matches_arithmetic():
    # Each stop costs leg(3600) + visit(3600) = 7200s. 28800 // 7200 = 4
    # stops/day exactly. 10 stops -> 4 + 4 + 2, final leg tacked onto day 3.
    legs = [leg(3600)] * 10 + [leg(60)]
    days = split_into_days(legs, stop_count=10, daily_limit_s=28800, visit_s=3600)

    assert [len(d["stop_indices"]) for d in days] == [4, 4, 2]
    assert [d["day"] for d in days] == [1, 2, 3]
    all_indices = [i for d in days for i in d["stop_indices"]]
    assert all_indices == list(range(10))
    assert days[-1]["drive_s"] == 2 * 3600 + 60
    assert all(not d["over_limit"] for d in days)


def test_mismatched_legs_length_raises_value_error():
    with pytest.raises(ValueError):
        split_into_days([leg(100), leg(100)], stop_count=5)
