import os

import httpx
from dotenv import load_dotenv

load_dotenv()

GOOGLE_GEOCODING_KEY = os.getenv("GOOGLE_GEOCODING_KEY")
GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"

# Colorado is close enough to a rectangle to bound with a simple lat/lng box
CO_BOUNDS = {"lat_min": 36.99, "lat_max": 41.01, "lng_min": -109.07, "lng_max": -102.03}

_cache: dict[str, dict] = {}
_reverse_cache: dict[str, dict] = {}


class GeocodeNotFoundError(Exception):
    """Место не найдено, либо найдено за пределами Колорадо."""


def _is_in_colorado(lat: float, lng: float) -> bool:
    return (
        CO_BOUNDS["lat_min"] <= lat <= CO_BOUNDS["lat_max"]
        and CO_BOUNDS["lng_min"] <= lng <= CO_BOUNDS["lng_max"]
    )


def geocode(query: str) -> dict:
    """Геокодирует запрос через Google Geocoding API, ограничивая поиск Колорадо."""
    key = query.strip().lower()
    if key in _cache:
        return _cache[key]

    params = {
        "address": query,
        "components": "administrative_area:CO|country:US",
        "key": GOOGLE_GEOCODING_KEY,
    }

    response = httpx.get(GEOCODE_URL, params=params, timeout=10.0)
    response.raise_for_status()
    data = response.json()

    if data.get("status") != "OK" or not data.get("results"):
        raise GeocodeNotFoundError(f"Место «{query}» не найдено в Колорадо.")

    result = data["results"][0]
    location = result["geometry"]["location"]
    lat, lng = location["lat"], location["lng"]

    if not _is_in_colorado(lat, lng):
        raise GeocodeNotFoundError(
            f"Место «{query}» найдено за пределами Колорадо — маршрутизация недоступна."
        )

    geocoded = {
        "name": query,
        "lat": lat,
        "lng": lng,
        "formatted_address": result.get("formatted_address", ""),
    }

    _cache[key] = geocoded
    return geocoded


def reverse_geocode(lat: float, lng: float) -> dict:
    """Обратный геокодинг координат в адрес через Google Geocoding API, ограничивая Колорадо."""
    key = f"{round(lat, 6)},{round(lng, 6)}"
    if key in _reverse_cache:
        return _reverse_cache[key]

    # Bounds are known upfront here (unlike forward geocode) — check before spending a request
    if not _is_in_colorado(lat, lng):
        raise GeocodeNotFoundError("Точка находится за пределами Колорадо — маршрутизация недоступна.")

    params = {
        "latlng": f"{lat},{lng}",
        "key": GOOGLE_GEOCODING_KEY,
    }

    response = httpx.get(GEOCODE_URL, params=params, timeout=10.0)
    response.raise_for_status()
    data = response.json()

    if data.get("status") != "OK" or not data.get("results"):
        raise GeocodeNotFoundError("Не удалось определить адрес для этой точки.")

    results = data["results"]
    formatted_address = results[0].get("formatted_address", "")
    locality_result = next((r for r in results if "locality" in r.get("types", [])), results[0])

    reverse_geocoded = {
        "name": locality_result.get("formatted_address", formatted_address),
        "formatted_address": formatted_address,
    }

    _reverse_cache[key] = reverse_geocoded
    return reverse_geocoded
