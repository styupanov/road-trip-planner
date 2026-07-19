from db import get_pool

_FIND_CANDIDATES_QUERY = """
    SELECT id, name, category, rating, review_count, about, website, duration,
           ST_Y(geom::geometry) AS lat, ST_X(geom::geometry) AS lon
    FROM public.attractions
    WHERE ST_DWithin(geom, ST_GeomFromText($1, 4326)::geography, $2)
      AND category = ANY($3::varchar[])
      AND review_count >= $4
    ORDER BY review_count DESC NULLS LAST
    LIMIT $5
"""


async def find_candidates_along_route(
    route_wkt: str,
    radius_m: int,
    categories: list[str],
    min_review_count: int = 20,
    limit: int = 50,
) -> list[dict]:
    """Ищет POI из public.attractions в коридоре вокруг маршрута."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            _FIND_CANDIDATES_QUERY,
            route_wkt,
            radius_m,
            categories,
            min_review_count,
            limit,
        )

    return [
        {
            "id": row["id"],
            "name": row["name"],
            "category": row["category"],
            "rating": row["rating"],
            "review_count": row["review_count"],
            "about": row["about"],
            "website": row["website"],
            "duration": row["duration"],
            "lat": row["lat"],
            "lon": row["lon"],
        }
        for row in rows
    ]
