import httpx

VALHALLA_URL = "http://localhost:8002"


def get_route(start_lat: float, start_lon: float, end_lat: float, end_lon: float):
    """Просит у Valhalla маршрут между двумя точками."""
    payload = {
        "locations": [
            {"lat": start_lat, "lon": start_lon},
            {"lat": end_lat, "lon": end_lon},
        ],
        "costing": "auto",
    }

    response = httpx.post(f"{VALHALLA_URL}/route", json=payload, timeout=30.0)
    response.raise_for_status()
    data = response.json()

    trip = data["trip"]
    summary = trip["summary"]
    return {
        "duration_seconds": summary["time"],
        "distance_km": summary["length"],
        "has_time_restrictions": summary.get("has_time_restrictions", False),
        "shape": trip["legs"][0]["shape"],
    }
