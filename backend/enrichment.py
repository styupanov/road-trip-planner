import json
import os

from dotenv import load_dotenv
from google import genai
from pydantic import BaseModel

load_dotenv()

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

# gemini-2.0-flash is retired; "gemini-flash-latest" is a floating alias Google
# repoints without notice — pin the concrete dated model instead so a Google-side
# rollover can't silently change behavior/cost under us.
MODEL = "gemini-3.5-flash"

_client: genai.Client | None = None


def _get_client() -> genai.Client:
    global _client
    if _client is None:
        _client = genai.Client(api_key=GEMINI_API_KEY)
    return _client


class EnrichmentError(Exception):
    """Gemini не вернула валидный ответ (транспортная ошибка, статус != completed,
    либо ответ не прошёл разбор JSON)."""


# --- Why this is two calls, not one -------------------------------------------
# Confirmed live, not assumed: combining tools=[google_search] with response_format
# on gemini-3.5-flash reliably corrupts the JSON. Grounding splices cited spans
# into the output at the text-stream level, and when that splice lands inside a
# response_format-shaped JSON string, the cited span's actual text sometimes
# never makes it into content.text while its url_citation annotation still does
# — confirmed across 9/9 observed failures, where the JSON parse error's byte
# offset always fell inside some annotation's [start_index, end_index] (those
# indices are BYTE offsets — Cyrillic is 2 bytes/char in UTF-8, so don't compare
# them to Python string length). Dropping response_format and asking for JSON
# via the prompt instead did NOT fix it: the corruption happens before the model
# ever "writes" JSON syntax, so no amount of prompt wording avoids it.
#
# The only reliable fix is structural: never let a grounded (tools=google_search)
# call also be the one producing the final JSON. Call 1 grounds and writes free
# text — nothing there needs to parse, so a dropped span just reads a little
# oddly instead of breaking anything. Call 2 takes that text plus the numeric
# route data and reformats it into strict JSON with response_format — since
# call 2 has no tools, no grounding, nothing ever splices into its output, and
# response_format is safe again (the Preview-only proscription is specifically
# structured-output + built-in-tools together).


# --- Call 1: grounded, free text -----------------------------------------------
_GROUND_SYSTEM_INSTRUCTION = """Ты исследуешь места остановок на маршруте. Для каждой остановки напиши: чем место интересно, практические заметки (доступ, сезон, пермиты). Если даны trip_dates — найди через поиск, что происходит в эти даты: события, фестивали, закрытия, сезонные особенности. Пиши на русском, свободным текстом, по одному абзацу на остановку, называй остановку по имени. Не выдумывай — только найденное или общеизвестное."""


def _build_ground_input(dto: dict) -> str:
    ground_dto = {
        "origin": dto.get("origin"),
        "destination": dto.get("destination"),
        "trip_dates": dto.get("trip_dates"),
        "stops": [
            {
                "id": s["id"],
                "name": s["name"],
                "about": s.get("about"),
                "website": s.get("website"),
            }
            for s in dto.get("stops", [])
        ],
    }
    return "Вот остановки маршрута:\n\n" + json.dumps(ground_dto, ensure_ascii=False, indent=2)


def _extract_sources(annotations: list) -> list[dict]:
    """All url_citation annotations, deduplicated by URL and kept in first-seen
    order. Deliberately NOT attributed to individual stops — byte-offset
    attribution was fragile (see module docstring above); a flat list of "what
    the search actually used" is honest and doesn't need that fragility."""
    seen: set[str] = set()
    sources: list[dict] = []
    for ann in annotations:
        if getattr(ann, "type", None) != "url_citation" or not ann.url:
            continue
        if ann.url in seen:
            continue
        seen.add(ann.url)
        sources.append({"url": ann.url, "title": ann.title or ann.url})
    return sources


async def _call_grounded(dto: dict) -> tuple[str, list[dict]]:
    """Free-text, grounded call. Nothing here needs to parse as anything, so a
    dropped/spliced span (see module docstring) just reads a little odd instead
    of breaking a structure — this call can never produce the "невалидный JSON"
    failure, by construction."""
    client = _get_client()

    try:
        interaction = await client.aio.interactions.create(
            model=MODEL,
            system_instruction=_GROUND_SYSTEM_INSTRUCTION,
            input=_build_ground_input(dto),
            tools=[{"type": "google_search"}],
            # "low": extraction + synthesis over already-searched facts, not
            # multi-step problem solving — gemini-3.5-flash defaults to
            # "medium" thinking, which the docs frame as overkill here.
            # Thinking tokens are billed as output tokens, so this is a
            # deliberate cost/latency choice, not a guess.
            generation_config={"thinking_level": "low"},
        )
    except Exception as e:
        raise EnrichmentError(f"Запрос к Gemini (поиск) не выполнен: {e}") from e

    if interaction.status != "completed":
        raise EnrichmentError(f"Gemini (поиск) вернула статус '{interaction.status}' вместо 'completed'.")

    text = (interaction.output_text or "").strip()
    if not text:
        raise EnrichmentError("Gemini (поиск) вернула пустой ответ.")

    annotations = []
    for step in interaction.steps or []:
        if step.type != "model_output":
            continue
        for block in step.content or []:
            if block.type == "text" and block.annotations:
                annotations.extend(block.annotations)

    return text, _extract_sources(annotations)


# --- Call 2: structuring, no grounding ------------------------------------------
class _EnrichedStopSchema(BaseModel):
    id: int
    why: str
    tips: str | None
    dates_note: str | None


class _EnrichResponseSchema(BaseModel):
    overview: str
    stops: list[_EnrichedStopSchema]
    warnings: list[str]


_STRUCTURE_RESPONSE_FORMAT = {
    "type": "text",
    "mime_type": "application/json",
    "schema": _EnrichResponseSchema.model_json_schema(),
}


# Architectural rule this whole module exists to enforce: the LLM NEVER computes
# geography. Every number (time, distance, detour) in the response must come
# verbatim from the route structure — Valhalla/Google already computed those.
# If the model starts inventing its own numbers, they'd sit right next to the
# real ones and look identical, and trust in ALL the numbers collapses.
_STRUCTURE_SYSTEM_INSTRUCTION = """Тебе дан свободный текст с фактами о местах и структура маршрута с точными числами. Собери JSON строго по схеме.
ЖЁСТКО: числа времени/расстояния/крюка бери ТОЛЬКО из структуры маршрута дословно. Из текста фактов числа маршрута НЕ брать — там их нет и быть не должно. why/tips/dates_note — пересказ фактов из текста своими словами. id каждой остановки — из структуры маршрута. Язык русский. dates_note=null если для остановки в тексте нет ничего про даты/сезон."""


def _build_structure_input(ground_text: str, dto: dict) -> str:
    route_numbers = {
        "origin": dto.get("origin"),
        "destination": dto.get("destination"),
        "total_duration_s": dto.get("total_duration_s"),
        "baseline_duration_s": dto.get("baseline_duration_s"),
        "delta_s": dto.get("delta_s"),
        "distance_km": dto.get("distance_km"),
        "stops": [
            {
                "id": s["id"],
                "name": s["name"],
                "detour_s": s.get("detour_s"),
                "duration_raw": s.get("duration_raw"),
            }
            for s in dto.get("stops", [])
        ],
    }
    return (
        "Текст с фактами (из веб-поиска):\n\n"
        + ground_text
        + "\n\nСтруктура маршрута с точными числами (единственный источник чисел):\n\n"
        + json.dumps(route_numbers, ensure_ascii=False, indent=2)
    )


def _strip_markdown_fence(text: str) -> str:
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
        if text.endswith("```"):
            text = text[: -len("```")]
    return text.strip()


def _parse_json_object(text: str) -> dict:
    """Parses `text` as a JSON object. On the first failure, retries once against
    the slice between the first '{' and the last '}' — cheap insurance against
    stray prose the model tacked on despite instructions — but never attempts
    any regex "repair" of the JSON's actual structure."""
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start == -1 or end == -1 or end < start:
            raise EnrichmentError(f"Gemini вернула невалидный JSON: {text!r}")
        try:
            parsed = json.loads(text[start : end + 1])
        except json.JSONDecodeError as e:
            raise EnrichmentError(f"Gemini вернула невалидный JSON: {e}. Ответ: {text!r}") from e

    if not isinstance(parsed, dict):
        raise EnrichmentError("Gemini вернула JSON, но не объект верхнего уровня.")
    return parsed


async def _call_structure(ground_text: str, dto: dict) -> dict:
    """No tools, no grounding — nothing can splice into this call's output, so
    response_format is safe here (see module docstring)."""
    client = _get_client()

    try:
        interaction = await client.aio.interactions.create(
            model=MODEL,
            system_instruction=_STRUCTURE_SYSTEM_INSTRUCTION,
            input=_build_structure_input(ground_text, dto),
            response_format=_STRUCTURE_RESPONSE_FORMAT,
            generation_config={"thinking_level": "low"},
        )
    except Exception as e:
        raise EnrichmentError(f"Запрос к Gemini (структурирование) не выполнен: {e}") from e

    if interaction.status != "completed":
        raise EnrichmentError(f"Gemini (структурирование) вернула статус '{interaction.status}' вместо 'completed'.")

    text = _strip_markdown_fence((interaction.output_text or "").strip())
    if not text:
        raise EnrichmentError("Gemini (структурирование) вернула пустой ответ.")

    return _parse_json_object(text)


async def enrich_route(dto: dict) -> dict:
    """Два вызова Gemini на весь маршрут — не по остановке. Не знает про
    Valhalla/PostGIS/detour/Google Directions: dto — просто данные, которые
    собрал вызывающий код. См. module docstring про то, почему это два вызова,
    а не один."""
    ground_text, sources = await _call_grounded(dto)
    parsed = await _call_structure(ground_text, dto)

    # Never trust an id Gemini invented — drop it rather than let a stop with a
    # made-up id (or a duplicate) reach the response.
    valid_ids = {stop["id"] for stop in dto.get("stops", [])}
    raw_stops = parsed.get("stops", [])
    stops = [s for s in raw_stops if isinstance(s, dict) and s.get("id") in valid_ids]

    return {
        "overview": parsed.get("overview") or "",
        "stops": stops,
        "warnings": parsed.get("warnings") or [],
        "sources": sources,
    }
