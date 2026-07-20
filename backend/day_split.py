# Default matches "balanced" pace's own cap (see services.stops's
# _AWAKE_LIMIT_S / awake_limit_s_for_pace) — used only when a caller doesn't
# have a pace-derived value to pass in yet.
_DEFAULT_AWAKE_LIMIT_S = 43200


def split_into_days(
    legs: list[dict],
    stop_count: int,
    daily_limit_s: int = 28800,
    visit_s: int = 3600,
    awake_limit_s: int = _DEFAULT_AWAKE_LIMIT_S,
) -> list[dict]:
    """Greedily splits a route (origin -> stop_1 -> ... -> stop_N -> dest) into
    driving days against TWO independent soft ceilings — a day closes as soon
    as adding the next stop would breach EITHER one:
    - daily_limit_s: DRIVING time alone (the quiz's "hours behind the wheel"
      answer). visit_s never counts toward this one.
    - awake_limit_s: driving + ALL visit_s for the day, combined (how long
      the trip's pace tolerates being "on" for — see services.stops's
      awake_limit_s_for_pace). This is the only one visit_s affects.
    Whichever limit is hit first closes the day; a day can end up flagged
    over_limit for either reason (see close_day below) — this function
    doesn't distinguish which one to the caller, that's a display concern.

    `legs` is per-hop drive time, length stop_count + 1: legs[i] is the drive
    from the previous point to stop i (for i < stop_count), and legs[stop_count]
    is the final drive from the last stop to dest. `visit_s` is charged once per
    stop actually assigned to a day — it's a flat estimate (not per-stop data),
    see the day dict's own "visit_s" field for why that matters downstream.

    A day never closes empty-handed: the first stop considered for a fresh day
    is always added to it, even if its own leg alone exceeds daily_limit_s (or
    leg + visit alone exceeds awake_limit_s) — the alternative is losing the
    stop entirely, which is worse than a day flagged over_limit. Splitting
    THAT single oversized leg mid-drive (e.g. at some hypothetical overnight
    point along it) is out of scope here — day boundaries only ever fall on
    stop points, never inside a leg.
    """
    if len(legs) != stop_count + 1:
        raise ValueError(
            f"legs must have length stop_count + 1 ({stop_count + 1}), got {len(legs)}"
        )

    days: list[dict] = []
    day_num = 1
    stop_indices: list[int] = []
    drive_s = 0
    visit_total_s = 0

    def close_day() -> None:
        nonlocal day_num, stop_indices, drive_s, visit_total_s
        total_s = drive_s + visit_total_s
        days.append({
            "day": day_num,
            "stop_indices": stop_indices,
            "drive_s": drive_s,
            "visit_s": visit_total_s,
            "total_s": total_s,
            "over_limit": drive_s > daily_limit_s or total_s > awake_limit_s,
        })
        day_num += 1
        stop_indices = []
        drive_s = 0
        visit_total_s = 0

    for i in range(stop_count):
        leg_s = legs[i]["duration_s"]
        drive_next = drive_s + leg_s
        awake_next = drive_s + visit_total_s + leg_s + visit_s
        # Only ever close a day that already has something in it — a brand-new
        # day always accepts the next stop regardless of overflow.
        if stop_indices and (drive_next > daily_limit_s or awake_next > awake_limit_s):
            close_day()
        stop_indices.append(i)
        drive_s += leg_s
        visit_total_s += visit_s

    # The drive to the destination always lands on whichever day is currently
    # open, however long it is — there's no stop after it to defer to a new
    # day for, and no rule to split a stop-less "just driving home" day off.
    drive_s += legs[stop_count]["duration_s"]
    close_day()

    return days
