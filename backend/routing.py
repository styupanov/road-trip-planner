import asyncio

import httpx
import polyline as polyline_lib

VALHALLA_URL = "http://localhost:8002"


def _request_route(locations: list[dict], alternates: int = 0) -> dict:
    payload = {"locations": locations, "costing": "auto"}
    if alternates:
        payload["alternates"] = alternates
    response = httpx.post(f"{VALHALLA_URL}/route", json=payload, timeout=30.0)
    response.raise_for_status()
    return response.json()


def _round_seconds(value: float | None) -> int | None:
    # Valhalla returns time as a float (fractional on longer routes — it only looks
    # integral by coincidence on short ones). round(), not int(): truncation would
    # systematically under-report duration. None (unreachable) passes through as-is.
    return None if value is None else round(value)


async def matrix(
    sources: list[tuple[float, float]],
    targets: list[tuple[float, float]],
    costing: str = "auto",
    costing_options: dict | None = None,
) -> list[list[dict]]:
    """Просит у Valhalla матрицу времени/расстояния между источниками и целями."""
    payload = {
        "sources": [{"lat": lat, "lon": lon} for lat, lon in sources],
        "targets": [{"lat": lat, "lon": lon} for lat, lon in targets],
        "costing": costing,
    }
    if costing_options is not None:
        payload["costing_options"] = {costing: costing_options}

    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"{VALHALLA_URL}/sources_to_targets", json=payload, timeout=30.0
        )
    response.raise_for_status()
    data = response.json()

    return [
        [
            {"time": _round_seconds(cell.get("time")), "distance": cell.get("distance")}
            for cell in row
        ]
        for row in data["sources_to_targets"]
    ]


def get_route(start_lat: float, start_lon: float, end_lat: float, end_lon: float):
    """Просит у Valhalla маршрут между двумя точками."""
    data = _request_route([
        {"lat": start_lat, "lon": start_lon},
        {"lat": end_lat, "lon": end_lon},
    ])

    trip = data["trip"]
    summary = trip["summary"]
    return {
        "duration_seconds": _round_seconds(summary["time"]),
        "distance_km": summary["length"],
        "has_time_restrictions": summary.get("has_time_restrictions", False),
        "shape": trip["legs"][0]["shape"],
    }


def get_route_multi(locations: list[dict]) -> dict:
    """Строит маршрут Valhalla по заданному списку точек, по порядку, без
    переупорядочивания. Каждая точка — dict с lat/lon и опциональным type:
    'break' (по умолчанию у Valhalla) разбивает маршрут на leg, 'via' — проходная
    точка, маршрут держится её, но leg не создаётся."""
    data = _request_route(locations)

    trip = data["trip"]
    summary = trip["summary"]
    legs = trip["legs"]

    # Valhalla encodes each leg's shape independently (precision 6) — decode and
    # merge into one path, dropping the duplicate point at each leg boundary,
    # then re-encode as a single polyline for the caller.
    combined_points: list[tuple[float, float]] = []
    leg_summaries = []
    for leg in legs:
        leg_points = polyline_lib.decode(leg["shape"], 6)
        if combined_points and leg_points and combined_points[-1] == leg_points[0]:
            leg_points = leg_points[1:]
        combined_points.extend(leg_points)
        leg_summary = leg["summary"]
        leg_summaries.append({
            "time": _round_seconds(leg_summary["time"]),
            "length": leg_summary["length"],
        })

    return {
        "duration_seconds": _round_seconds(summary["time"]),
        "distance_km": summary["length"],
        "has_time_restrictions": summary.get("has_time_restrictions", False),
        "shape": polyline_lib.encode(combined_points, 6),
        "leg_summaries": leg_summaries,
    }


async def get_route_alternates(
    origin: tuple[float, float],
    destination: tuple[float, float],
    alternates: int = 2,
) -> list[dict]:
    """Запрашивает у Valhalla основной маршрут и до `alternates` альтернатив (главный
    вариант — первым). Valhalla может вернуть меньше альтернатив, чем запрошено,
    или ни одной — это не ошибка, просто список короче."""
    locations = [
        {"lat": origin[0], "lon": origin[1]},
        {"lat": destination[0], "lon": destination[1]},
    ]
    data = await asyncio.to_thread(_request_route, locations, alternates)

    # The primary route sits at data["trip"]; each alternative is wrapped one level
    # deeper as {"trip": {...}} inside data["alternates"] — easy to miss.
    trips = [data["trip"]] + [alt["trip"] for alt in data.get("alternates", [])]

    options = []
    for trip in trips:
        summary = trip["summary"]
        options.append({
            "duration_s": _round_seconds(summary["time"]),
            "distance_km": summary["length"],
            "shape": trip["legs"][0]["shape"],
        })
    return options
