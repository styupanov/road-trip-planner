def split_into_days(
    legs: list[dict],
    stop_count: int,
    daily_limit_s: int = 28800,
    visit_s: int = 3600,
) -> list[dict]:
    """Greedily splits a route (origin -> stop_1 -> ... -> stop_N -> dest) into
    driving days against a soft daily time ceiling.

    `legs` is per-hop drive time, length stop_count + 1: legs[i] is the drive
    from the previous point to stop i (for i < stop_count), and legs[stop_count]
    is the final drive from the last stop to dest. `visit_s` is charged once per
    stop actually assigned to a day — it's a flat estimate (not per-stop data),
    see the day dict's own "visit_s" field for why that matters downstream.

    A day never closes empty-handed: the first stop considered for a fresh day
    is always added to it, even if its own leg + visit alone exceeds
    daily_limit_s — the alternative is losing the stop entirely, which is worse
    than a day flagged over_limit. Whether a day is over_limit is decided by
    its actual total against the limit, not by tracking which case produced
    it — that stays true whether the culprit was one huge leg or (in principle)
    boundary rounding, so there's exactly one place this is decided.
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
            "over_limit": total_s > daily_limit_s,
        })
        day_num += 1
        stop_indices = []
        drive_s = 0
        visit_total_s = 0

    for i in range(stop_count):
        leg_s = legs[i]["duration_s"]
        addition = leg_s + visit_s
        # Only ever close a day that already has something in it — a brand-new
        # day always accepts the next stop regardless of overflow.
        if stop_indices and (drive_s + visit_total_s + addition > daily_limit_s):
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
