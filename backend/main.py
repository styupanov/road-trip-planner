from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import routing
import geocoding

app = FastAPI(title="Verified Road Trip Planner API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def read_root():
    return {"status": "alive", "service": "roadtrip-backend"}


@app.get("/health")
def health_check():
    return {"status": "ok"}


@app.get("/route")
def route(start_lat: float, start_lon: float, end_lat: float, end_lon: float):
    return routing.get_route(start_lat, start_lon, end_lat, end_lon)


@app.get("/geocode")
def geocode(q: str):
    try:
        return geocoding.geocode(q)
    except geocoding.GeocodeNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/reverse-geocode")
def reverse_geocode(lat: float, lng: float):
    try:
        return geocoding.reverse_geocode(lat, lng)
    except geocoding.GeocodeNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
