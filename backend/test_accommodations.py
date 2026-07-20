import accommodations


def _place(place_id, rating=None, user_ratings_total=None, distance_m=0):
    return {
        "place_id": place_id, "name": place_id, "lat": 0, "lon": 0,
        "rating": rating, "user_ratings_total": user_ratings_total,
        "price_level": None, "vicinity": None, "maps_url": f"url_{place_id}",
        "distance_m": distance_m,
    }


def test_rank_for_selection_bayes_score_beats_raw_rating():
    """The exact live-data failure this function exists to fix: a thin
    5.0/1-review place must not outrank a well-reviewed 4.4/587 — but the
    5.0/1 place is also below the reliability threshold (10 reviews) here,
    so with two OTHER reliable candidates present it's dropped outright,
    not just outranked. See test_..._drops_unreliable_when_reliable_exist
    below for that half; this test focuses on the ordering among survivors."""
    thin_five_star = _place("thin", rating=5.0, user_ratings_total=1)
    hampton = _place("hampton", rating=4.4, user_ratings_total=587)
    another_reliable = _place("another", rating=4.6, user_ratings_total=50)

    ranked = accommodations.rank_for_selection([thin_five_star, hampton, another_reliable])

    assert "thin" not in [p["place_id"] for p in ranked]
    # hampton's bayes score (4.4 * ln(588) ≈ 28.1) beats another's
    # (4.6 * ln(51) ≈ 18.1) despite the lower raw rating.
    assert [p["place_id"] for p in ranked] == ["hampton", "another"]


def test_rank_for_selection_drops_unreliable_when_reliable_options_exist():
    """Google Places type=lodging misclassifications (an office, a trail-ride
    outfitter — anything with a thin or absent review history) must be
    invisible to the user once real, well-reviewed lodging exists nearby."""
    office = _place("office", rating=5.0, user_ratings_total=1)
    trail_rides = _place("trail_rides", rating=4.5, user_ratings_total=6)
    hampton = _place("hampton", rating=4.4, user_ratings_total=587)
    campground = _place("campground", rating=4.6, user_ratings_total=211)

    ranked = accommodations.rank_for_selection([office, trail_rides, hampton, campground])

    ids = [p["place_id"] for p in ranked]
    assert "office" not in ids
    assert "trail_rides" not in ids
    assert set(ids) == {"hampton", "campground"}


def test_rank_for_selection_remote_area_shows_unreliable_rather_than_nothing():
    """A genuinely remote corridor — nothing but thin-review campgrounds and
    an unrated site — must still return options, not an empty list. Below
    the "enough reliable candidates" bar, the filter lifts entirely."""
    campground_a = _place("camp_a", rating=4.2, user_ratings_total=3)
    campground_b = _place("camp_b", rating=3.8, user_ratings_total=2)
    unrated_site = _place("unrated", distance_m=100)

    ranked = accommodations.rank_for_selection([unrated_site, campground_a, campground_b])

    assert len(ranked) == 3
    # Rated (by Bayes score, however thin) first, unrated last.
    assert [p["place_id"] for p in ranked] == ["camp_a", "camp_b", "unrated"]


def test_rank_for_selection_single_reliable_candidate_does_not_trigger_filter():
    """Exactly one reliable place isn't "enough reliable options" (threshold
    is 2) — the filter must not fire and hide everything else down to just
    that one entry; the thin/unrated ones stay visible too."""
    solid = _place("solid", rating=4.5, user_ratings_total=40)
    thin = _place("thin", rating=4.0, user_ratings_total=2)

    ranked = accommodations.rank_for_selection([thin, solid])

    assert {p["place_id"] for p in ranked} == {"solid", "thin"}


def test_rank_for_selection_caps_at_five():
    places = [_place(f"p{i}", rating=4.0 + i * 0.05, user_ratings_total=20) for i in range(8)]

    ranked = accommodations.rank_for_selection(places)

    assert len(ranked) == 5


def test_rank_for_selection_empty_list():
    assert accommodations.rank_for_selection([]) == []
