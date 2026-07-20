import pytest

from day_split import split_into_days


def leg(duration_s):
    return {"duration_s": duration_s}


def test_route_fits_in_one_day():
    # 3 short stops + short final leg, well under either ceiling.
    legs = [leg(1000), leg(1000), leg(1000), leg(1000)]
    days = split_into_days(legs, stop_count=3, daily_limit_s=28800, visit_s=3600, awake_limit_s=43200)

    assert len(days) == 1
    assert days[0]["stop_indices"] == [0, 1, 2]
    assert days[0]["drive_s"] == 4000
    assert days[0]["visit_s"] == 3 * 3600
    assert days[0]["total_s"] == 4000 + 3 * 3600
    assert days[0]["over_limit"] is False


def test_single_leg_longer_than_limit_is_kept_not_lost():
    # The leg to stop 0 alone is longer than daily_limit_s — it must still
    # become its own (over-limit) day, not be dropped or loop forever. A day
    # never closes empty-handed, regardless of which ceiling would otherwise
    # be blown.
    legs = [leg(40000), leg(500)]
    days = split_into_days(legs, stop_count=1, daily_limit_s=28800, visit_s=3600, awake_limit_s=43200)

    assert len(days) == 1
    assert days[0]["stop_indices"] == [0]
    assert days[0]["drive_s"] == 40000 + 500
    assert days[0]["over_limit"] is True


def test_empty_stops_is_one_day_origin_to_dest():
    legs = [leg(12345)]
    days = split_into_days(legs, stop_count=0, daily_limit_s=28800, visit_s=3600, awake_limit_s=43200)

    assert len(days) == 1
    assert days[0]["stop_indices"] == []
    assert days[0]["drive_s"] == 12345
    assert days[0]["visit_s"] == 0
    assert days[0]["total_s"] == 12345
    assert days[0]["over_limit"] is False


def test_mismatched_legs_length_raises_value_error():
    with pytest.raises(ValueError):
        split_into_days([leg(100), leg(100)], stop_count=5)


# --- daily_limit_s: DRIVING alone -- visit_s must never affect this --------

def test_splits_by_drive_alone_when_visit_is_negligible():
    """Long legs, negligible visit_s, a huge awake_limit_s (so it can never
    be the trigger) — pure drive-time ceiling math. Each 4h leg alone already
    exceeds what's left of a fresh 6h day the moment a second one would be
    added, so every stop lands on its own day: 5 stops -> 5 days."""
    hour = 3600
    legs = [leg(4 * hour)] * 5 + [leg(0)]

    days = split_into_days(
        legs, stop_count=5, daily_limit_s=6 * hour, visit_s=60, awake_limit_s=100 * hour,
    )

    assert len(days) == 5
    assert all(len(d["stop_indices"]) == 1 for d in days)
    # visit_s (60s) is negligible on purpose — confirms it isn't what's
    # driving the split; each day's drive_s alone already explains it.
    assert all(d["drive_s"] == 4 * hour for d in days)


def test_visit_s_does_not_affect_a_drive_only_split():
    """Same drive-time shape, but visit_s cranked way up with awake_limit_s
    set high enough to never trigger — the number of days (and which stops
    land on which day) must be UNCHANGED by visit_s. This is the direct
    regression check for the original bug: visit_s used to eat into the
    drive budget instead of being a separate ceiling."""
    hour = 3600
    legs = [leg(2 * hour)] * 4 + [leg(0)]

    days_tiny_visit = split_into_days(
        legs, stop_count=4, daily_limit_s=8 * hour, visit_s=1, awake_limit_s=100 * hour,
    )
    days_huge_visit = split_into_days(
        legs, stop_count=4, daily_limit_s=8 * hour, visit_s=4 * hour, awake_limit_s=100 * hour,
    )

    assert len(days_tiny_visit) == len(days_huge_visit) == 1
    assert days_tiny_visit[0]["stop_indices"] == days_huge_visit[0]["stop_indices"] == [0, 1, 2, 3]
    assert days_tiny_visit[0]["drive_s"] == days_huge_visit[0]["drive_s"] == 8 * hour


# --- awake_limit_s: DRIVE + ALL visit_s combined, the second ceiling -------

def test_splits_by_awake_when_stops_are_dense_and_legs_are_short():
    """Short legs (drive alone never comes remotely close to daily_limit_s),
    but visit_s piles up fast — the split must be driven by awake_limit_s.
    Each stop costs 60s drive + 3600s visit = 3660s combined; awake_limit_s
    is sized for exactly 2 stops/day (2*3660=7320, a 3rd would need 10980)."""
    legs = [leg(60)] * 6 + [leg(0)]

    days = split_into_days(
        legs, stop_count=6, daily_limit_s=100 * 3600, visit_s=3600, awake_limit_s=2 * 3600 + 120,
    )

    assert len(days) == 3
    assert [len(d["stop_indices"]) for d in days] == [2, 2, 2]
    assert all(d["drive_s"] == 120 for d in days)  # drive stayed tiny throughout


def test_awake_limit_varies_by_pace_changes_day_count():
    """Same route, same stops, same (huge, never-triggering) daily_limit_s —
    only awake_limit_s (which pace maps to, see
    services.stops.awake_limit_s_for_pace) changes. Each stop costs exactly
    3600(drive)+3600(visit)=7200s, so relaxed (36000s -> 5 stops/day) needs
    MORE days than packed (50400s -> 7 stops/day) for the same 12 stops."""
    legs = [leg(3600)] * 12 + [leg(0)]

    relaxed_days = split_into_days(
        legs, stop_count=12, daily_limit_s=100 * 3600, visit_s=3600, awake_limit_s=36000,
    )
    packed_days = split_into_days(
        legs, stop_count=12, daily_limit_s=100 * 3600, visit_s=3600, awake_limit_s=50400,
    )

    assert [len(d["stop_indices"]) for d in relaxed_days] == [5, 5, 2]
    assert [len(d["stop_indices"]) for d in packed_days] == [7, 5]
    assert len(relaxed_days) > len(packed_days)


# --- over_limit: one flag, either cause ------------------------------------

def test_over_limit_true_when_only_drive_exceeds():
    legs = [leg(40000), leg(0)]
    days = split_into_days(legs, stop_count=1, daily_limit_s=28800, visit_s=0, awake_limit_s=100000)

    assert days[0]["drive_s"] > 28800
    assert days[0]["total_s"] <= 100000  # awake never breached
    assert days[0]["over_limit"] is True


def test_over_limit_true_when_only_awake_exceeds():
    # Drive is tiny (well under daily_limit_s), but visit_s alone blows the
    # awake ceiling — over_limit must still fire. This is exactly the case
    # the original bug conflated with the drive-caused one (a single shared
    # comparison), so it's the one most likely to regress silently.
    legs = [leg(100), leg(0)]
    days = split_into_days(legs, stop_count=1, daily_limit_s=28800, visit_s=40000, awake_limit_s=28800)

    assert days[0]["drive_s"] <= 28800  # drive alone is fine
    assert days[0]["total_s"] > 28800   # but awake (drive+visit) isn't
    assert days[0]["over_limit"] is True


# --- regression: Durango<->Leadville round-trip no longer over-splits ------

def test_round_trip_durango_leadville_no_longer_inflates_to_six_days():
    """Exact per-hop drive times from the live diagnostic (Durango<->Leadville
    round-trip, 2 suggested stops on leg1 + 4 on leg2, pivot merged into one
    hop): [7178, 13958, 8343, 8545, 4856, 4115, 6827]s, 6 stops total,
    14.95h driving overall. Under the OLD rule (visit_s eating daily_limit_s)
    this produced 6 days for a "4 days +/-1" quiz request purely because
    visit_s (1h/stop) was counted against the 4h drive-only limit. With
    daily_limit_s=14400 (quiz "до 4ч") and awake_limit_s=43200
    (moderate/balanced pace, 12h) it must now produce noticeably fewer days —
    this is the direct regression test for the bug."""
    legs = [leg(d) for d in [7178, 13958, 8343, 8545, 4856, 4115, 6827]]

    days = split_into_days(legs, stop_count=6, daily_limit_s=14400, visit_s=3600, awake_limit_s=43200)

    assert len(days) < 6  # was 6 before the fix
    assert len(days) == 5  # exact, deterministic result for this fixed input
    # Day 4 now correctly packs TWO stops together (indices 3 and 4) — proof
    # the fix actually enables packing across stops, not just a smaller
    # number by coincidence.
    assert [len(d["stop_indices"]) for d in days] == [1, 1, 1, 2, 1]
