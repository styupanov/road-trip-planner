import pytest

from detour import DetourResult, compute_detours


def test_poi_exactly_on_route_has_zero_detour():
    results = compute_detours(baseline_s=1000, to_poi=[400], from_poi=[600])
    assert results == [DetourResult(0, 0, 400, 600, reachable=True)]


def test_snapping_sum_below_baseline_clamps_to_zero():
    results = compute_detours(baseline_s=1000, to_poi=[400], from_poi=[595])
    assert results[0].detour_s == 0
    assert results[0].reachable is True


def test_normal_detour_arithmetic():
    results = compute_detours(baseline_s=1000, to_poi=[700], from_poi=[500])
    assert results[0].detour_s == 200
    assert results[0].to_poi_s == 700
    assert results[0].from_poi_s == 500
    assert results[0].reachable is True


def test_none_in_to_poi_marks_unreachable_and_is_kept():
    results = compute_detours(baseline_s=1000, to_poi=[None], from_poi=[500])
    assert len(results) == 1
    r = results[0]
    assert r.reachable is False
    assert r.detour_s is None
    assert r.to_poi_s is None
    assert r.from_poi_s == 500
    assert r.index == 0


def test_none_in_from_poi_marks_unreachable_and_is_kept():
    results = compute_detours(baseline_s=1000, to_poi=[500], from_poi=[None])
    assert len(results) == 1
    r = results[0]
    assert r.reachable is False
    assert r.detour_s is None
    assert r.to_poi_s == 500
    assert r.from_poi_s is None


def test_threshold_filters_out_reachable_over_limit():
    results = compute_detours(
        baseline_s=1000,
        to_poi=[700, 800],
        from_poi=[500, 900],
        max_detour_s=300,
    )
    assert len(results) == 1
    assert results[0].index == 0
    assert results[0].detour_s == 200


def test_threshold_does_not_filter_unreachable():
    results = compute_detours(
        baseline_s=1000,
        to_poi=[None, 800],
        from_poi=[500, 900],
        max_detour_s=300,
    )
    indices = [r.index for r in results]
    assert 0 in indices
    unreachable = next(r for r in results if r.index == 0)
    assert unreachable.reachable is False
    assert unreachable.detour_s is None


def test_index_preserved_after_filtering():
    results = compute_detours(
        baseline_s=1000,
        to_poi=[100, 700, 100],
        from_poi=[100, 900, 100],
        max_detour_s=50,
    )
    indices = [r.index for r in results]
    assert indices == [0, 2]


def test_mismatched_lengths_raise_value_error():
    with pytest.raises(ValueError):
        compute_detours(baseline_s=1000, to_poi=[100, 200], from_poi=[100])
