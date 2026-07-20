import math
import os

import httpx
from dotenv import load_dotenv

load_dotenv()

# Reuses the Directions key, not Geocoding — Geocoding is confirmed NOT
# authorized for Directions (see directions.py's own comment), so the two
# keys are restricted independently per-API in Cloud Console even though
# they're the same Google account/project. Directions is the closer sibling
# to Places (both "real-world POI" APIs), so it's the first one tried here.
# If it isn't authorized for Places either, Google returns REQUEST_DENIED —
# check_lodging.py surfaces that plainly so the right API can be enabled.
GOOGLE_PLACES_KEY = os.getenv("GOOGLE_DIRECTIONS_KEY")
NEARBY_SEARCH_URL = "https://maps.googleapis.com/maps/api/place/nearbysearch/json"

# (round(lat, 5), round(lon, 5), radius_m) -> full sorted result list (NOT
# truncated to any particular `limit` — see find_nearest_lodging, which
# slices at return time so a later call with a bigger `limit` for the same
# point/radius still hits this cache instead of re-querying). Places calls
# are billed, same in-memory-cache convention as geocoding.py/directions.py.
_cache: dict[tuple, list[dict]] = {}


class PlacesError(Exception):
    """Google Places не смог выполнить поиск (REQUEST_DENIED, лимит квоты,
    невалидный запрос). НЕ включает ZERO_RESULTS — то просто означает
    "ночлега поблизости нет" и возвращается как пустой список, не ошибка."""


def _distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine, метры. Точности достаточно для сортировки результатов
    внутри радиуса поиска (десятки км) — не для навигации."""
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


async def find_nearest_lodging(
    lat: float, lon: float, radius_m: int, limit: int = 3
) -> list[dict]:
    """Ищет ночлег рядом с точкой. Сегодня — через Google Places Nearby
    Search (type=lodging); вызывающий код (будущий day_split — ночёвки,
    подшаг 2) НЕ должен знать об этом источнике. Возвращаемая форма —
    собственный контракт этого модуля, не сырой ответ Google:

        {place_id, name, lat, lon, rating, user_ratings_total,
         price_level, vicinity, maps_url}

    Если источник позже сменится (SearchApi/SerpApi с ценами на конкретные
    даты, Booking) — меняется только тело этой функции; форма результата и
    вызывающий код остаются прежними. place_id — из Google Places API,
    единственное поле, которое привязывает результат к конкретному
    источнику; при смене источника это же поле просто станет значить
    что-то другое (id в новой системе) без переименования.

    Radius+prominence (ранжирование Google по умолчанию внутри radius_m),
    не rankby=distance: Places API не разрешает сочетать rankby=distance с
    radius, а radius_m — обязательный параметр контракта этой функции.
    Сортировку по расстоянию делаем на своей стороне (_distance_m) — тот же
    результат "ближайшее первым", без отказа от ограничения по радиусу.

    Закрытые навсегда места (business_status=CLOSED_PERMANENTLY) отфильтрованы
    — бесполезны как предложение ночлега.

    Пустой список, если ничего не найдено — не исключение. DirectionsError-
    подобный PlacesError — только для настоящих сбоев (REQUEST_DENIED и т.п.),
    не пойман здесь намеренно, как и в directions.py/geocoding.py — решает
    вызывающий код.
    """
    cache_key = (round(lat, 5), round(lon, 5), radius_m)
    if cache_key in _cache:
        return _cache[cache_key][:limit]

    params = {
        "location": f"{lat},{lon}",
        "radius": radius_m,
        "type": "lodging",
        "key": GOOGLE_PLACES_KEY,
    }

    async with httpx.AsyncClient() as client:
        response = await client.get(NEARBY_SEARCH_URL, params=params, timeout=15.0)
    response.raise_for_status()
    data = response.json()

    status = data.get("status")
    if status == "ZERO_RESULTS":
        _cache[cache_key] = []
        return []
    if status != "OK":
        raise PlacesError(
            f"Google Places: {status} {data.get('error_message', '')}".strip()
        )

    scored: list[tuple[float, dict]] = []
    for place in data.get("results", []):
        if place.get("business_status") == "CLOSED_PERMANENTLY":
            continue
        location = place.get("geometry", {}).get("location", {})
        place_lat, place_lon = location.get("lat"), location.get("lng")
        if place_lat is None or place_lon is None:
            continue

        dist = _distance_m(lat, lon, place_lat, place_lon)
        scored.append((dist, {
            "place_id": place["place_id"],
            "name": place["name"],
            "lat": place_lat,
            "lon": place_lon,
            "rating": place.get("rating"),
            "user_ratings_total": place.get("user_ratings_total"),
            "price_level": place.get("price_level"),
            "vicinity": place.get("vicinity"),
            "maps_url": f"https://www.google.com/maps/place/?q=place_id:{place['place_id']}",
        }))

    scored.sort(key=lambda pair: pair[0])
    results = [item for _, item in scored]

    _cache[cache_key] = results
    return results[:limit]
