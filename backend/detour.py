from dataclasses import dataclass


@dataclass
class DetourResult:
    index: int
    detour_s: int | None
    to_poi_s: int | None
    from_poi_s: int | None
    reachable: bool


def compute_detours(
    baseline_s: int,
    to_poi: list[int | None],
    from_poi: list[int | None],
    max_detour_s: int | None = None,
) -> list[DetourResult]:
    if len(to_poi) != len(from_poi):
        raise ValueError("to_poi and from_poi must have the same length")

    results = []
    for i, (t, f) in enumerate(zip(to_poi, from_poi)):
        if t is None or f is None:
            results.append(DetourResult(i, None, t, f, reachable=False))
            continue

        detour = max(0, t + f - baseline_s)

        if max_detour_s is not None and detour > max_detour_s:
            continue

        results.append(DetourResult(i, detour, t, f, reachable=True))

    return results
