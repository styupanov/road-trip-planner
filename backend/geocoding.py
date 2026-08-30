import os

import httpx
from dotenv import load_dotenv

load_dotenv()

GOOGLE_GEOCODING_KEY = os.getenv("GOOGLE_GEOCODING_KEY")
GEOCODE_URL = "https://maps.googleapis.com/maps/api/geocode/json"

_cache: dict[str, dict] = {}
_reverse_cache: dict[str, dict] = {}


class GeocodeNotFoundError(Exception):
    """Google не нашёл место/адрес для этого запроса или этих координат."""


def geocode(query: str) -> dict:
    """Геокодирует запрос через Google Geocoding API, ограничивая поиск США
    (Valhalla's tiles are US-wide, but not global — country:US keeps a
    forward geocode from resolving to an address Valhalla could never
    route to; no narrower region restriction, see CLAUDE.md/routing.py)."""
    key = query.strip().lower()
    if key in _cache:
        return _cache[key]

    params = {
        "address": query,
        "components": "country:US",
        "key": GOOGLE_GEOCODING_KEY,
    }

    response = httpx.get(GEOCODE_URL, params=params, timeout=10.0)
    response.raise_for_status()
    data = response.json()

    if data.get("status") != "OK" or not data.get("results"):
        raise GeocodeNotFoundError(f"Место «{query}» не найдено.")

    result = data["results"][0]
    location = result["geometry"]["location"]
    lat, lng = location["lat"], location["lng"]

    geocoded = {
        "name": query,
        "lat": lat,
        "lng": lng,
        "formatted_address": result.get("formatted_address", ""),
    }

    _cache[key] = geocoded
    return geocoded


def reverse_geocode(lat: float, lng: float) -> dict:
    """Обратный геокодинг координат в адрес через Google Geocoding API."""
    key = f"{round(lat, 6)},{round(lng, 6)}"
    if key in _reverse_cache:
        return _reverse_cache[key]

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
