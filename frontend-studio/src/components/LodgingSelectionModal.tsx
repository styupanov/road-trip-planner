import React, { useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, Star } from 'lucide-react';
import { DayEndPoint, LodgingOption, PreviewDay, SelectedLodging, geocode } from '../api';
import { formatDuration } from '../format';
import { dayColor } from '../dayColors';

// Non-blocking — the user can still continue past this, it's just a warning
// that the day's drive will get longer as a result (see CustomLodgingCard).
const DISTANCE_WARNING_THRESHOLD_KM = 50;

function haversineKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export interface CustomLodgingPoint {
  lat: number;
  lon: number;
  name: string;
}

// A day's radio selection is either one of the Places candidates, or a
// custom point — `point: null` means the "Указать своё место" radio is
// active but nothing has been entered/picked yet (input block still shown).
type LodgingChoice =
  | { kind: 'place'; option: LodgingOption }
  | { kind: 'custom'; point: CustomLodgingPoint | null };

export interface LodgingSelectionModalProps {
  isOpen: boolean;
  days: PreviewDay[];
  onContinue: (selected: SelectedLodging[]) => void;
  onSkip: () => void;
  onCancel: () => void;
  // "Выбрать на карте" — App.tsx hides this modal (it stays mounted, see
  // index.css's .modal/.modal.on) and switches the map into click-to-pick
  // mode for this day.
  onPickOnMap: (day: number) => void;
  // One-shot relay for a resolved map click, cleared via onMapPickResultConsumed
  // once applied to choiceByDay below.
  mapPickResult: { day: number; lat: number; lon: number; name: string } | null;
  onMapPickResultConsumed: () => void;
  // Re-lodging an already-finalized trip (FinalizedView's "Изменить
  // ночёвки"): the CURRENT version's picks, one entry per night that has
  // one — pre-selects them instead of defaulting to "first option" per day.
  // Undefined/omitted for a fresh finalize (no prior picks to restore).
  existingLodging?: ExistingLodgingEntry[];
}

export interface ExistingLodgingEntry {
  day: number;
  place_id: string | null;
  lat: number;
  lon: number;
  name: string;
  custom: boolean;
}

const formatDistance = (m: number): string =>
  m < 1000 ? `в ${Math.round(m)} м` : `в ${(m / 1000).toFixed(1)} км`;

const formatPriceLevel = (level: number | null): string | null =>
  level ? '$'.repeat(level) : null;

const LodgingCard: React.FC<{
  option: LodgingOption;
  dayNumber: number;
  isSelected: boolean;
  onSelect: () => void;
}> = ({ option, dayNumber, isSelected, onSelect }) => {
  const price = formatPriceLevel(option.price_level);

  return (
    <label
      className={`flex gap-2.5 p-2.5 rounded border cursor-pointer transition-colors ${
        isSelected ? 'bg-[#2c3138] border-[#e8b53f]' : 'bg-[#1a1d21] border-transparent hover:bg-[#22262b]'
      }`}
    >
      <input
        type="radio"
        name={`lodging-day-${dayNumber}`}
        checked={isSelected}
        onChange={onSelect}
        className="mt-1 flex-shrink-0 accent-[#e8b53f] cursor-pointer"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[14px] font-medium text-[#f2ede3] truncate">{option.name}</div>
          {price && <span className="text-[11px] font-mono text-[#8b9199] flex-shrink-0">{price}</span>}
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px] font-mono text-[#8b9199]">
          {option.rating != null ? (
            <span className="flex items-center gap-0.5">
              <Star size={11} className="text-[#e8b53f] flex-shrink-0" fill="currentColor" />
              {option.rating.toFixed(1)}
              {option.user_ratings_total != null && ` (${option.user_ratings_total})`}
            </span>
          ) : (
            <span>без рейтинга</span>
          )}
          <span>·</span>
          <span>{formatDistance(option.distance_m)}</span>
        </div>
        {option.vicinity && (
          <div className="text-[11px] text-[#5a5f66] truncate mt-0.5">{option.vicinity}</div>
        )}
        <a
          href={option.maps_url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 text-[10px] text-[#6a9fd8] hover:underline mt-1"
        >
          Открыть в Google Maps
          <ExternalLink size={10} />
        </a>
      </div>
    </label>
  );
};

// The "Указать своё место" radio option — expands an input block (address
// text search, or "Выбрать на карте") while selected. Address search reuses
// the existing /geocode endpoint (same one origin/dest use), not a new API.
const CustomLodgingCard: React.FC<{
  dayNumber: number;
  endPoint: DayEndPoint;
  isSelected: boolean;
  point: CustomLodgingPoint | null;
  onChoose: () => void;
  onPointChange: (point: CustomLodgingPoint | null) => void;
  onPickOnMap: () => void;
}> = ({ dayNumber, endPoint, isSelected, point, onChoose, onPointChange, onPickOnMap }) => {
  const [addressInput, setAddressInput] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSearch = async () => {
    const query = addressInput.trim();
    if (!query) return;
    setSearching(true);
    setError(null);
    try {
      // formatted_address, not `name` — geocode() echoes the raw query back
      // as `name`, formatted_address is the actually-resolved address.
      const result = await geocode(query);
      onPointChange({ lat: result.lat, lon: result.lng, name: result.formatted_address || query });
    } catch (err) {
      setError((err as Error).message || 'Не удалось найти адрес.');
    } finally {
      setSearching(false);
    }
  };

  const distanceKm = point ? haversineKm(point, { lat: endPoint.lat, lon: endPoint.lon }) : null;
  const showDistanceWarning = distanceKm != null && distanceKm > DISTANCE_WARNING_THRESHOLD_KM;

  return (
    <label
      className={`flex gap-2.5 p-2.5 rounded border cursor-pointer transition-colors ${
        isSelected ? 'bg-[#2c3138] border-[#e8b53f]' : 'bg-[#1a1d21] border-transparent hover:bg-[#22262b]'
      }`}
    >
      <input
        type="radio"
        name={`lodging-day-${dayNumber}`}
        checked={isSelected}
        onChange={onChoose}
        className="mt-1 flex-shrink-0 accent-[#e8b53f] cursor-pointer"
      />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-[#f2ede3]">Указать своё место</div>

        {isSelected && (
          <div className="mt-2 space-y-2">
            {point ? (
              <div className="flex items-center justify-between gap-2 text-[12px] text-[#c7cdd4]">
                <span className="truncate">{point.name}</span>
                <button
                  type="button"
                  className="text-[11px] text-[#6a9fd8] hover:underline flex-shrink-0 cursor-pointer"
                  onClick={() => onPointChange(null)}
                >
                  Изменить
                </button>
              </div>
            ) : (
              <>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={addressInput}
                    onChange={(e) => setAddressInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleSearch();
                      }
                    }}
                    placeholder="Адрес или название места"
                    className="flex-1 min-w-0 px-2 py-1.5 text-[12px] rounded bg-[#14171a] border border-[#3a4048] text-[#f2ede3] placeholder:text-[#5a5f66]"
                  />
                  <button
                    type="button"
                    disabled={searching || !addressInput.trim()}
                    onClick={handleSearch}
                    className="px-3 py-1.5 text-[11px] font-semibold rounded bg-[#3a4048] text-white hover:bg-opacity-80 disabled:opacity-50 cursor-pointer flex-shrink-0"
                  >
                    {searching ? '...' : 'Найти'}
                  </button>
                </div>
                {error && <p className="text-[11px] text-[#c05640]">{error}</p>}
                <button
                  type="button"
                  onClick={onPickOnMap}
                  className="text-[11px] text-[#6a9fd8] hover:underline cursor-pointer"
                >
                  Выбрать на карте
                </button>
              </>
            )}

            {showDistanceWarning && (
              <div className="flex items-start gap-1.5 text-[11px] text-[#e8b53f]">
                <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
                <span>Это в {Math.round(distanceKm!)} км от конца дня — день станет длиннее.</span>
              </div>
            )}
          </div>
        )}
      </div>
    </label>
  );
};

const DayLodgingSection: React.FC<{
  day: PreviewDay;
  choice: LodgingChoice | undefined;
  onChoosePlace: (option: LodgingOption) => void;
  onChooseCustom: () => void;
  onCustomPointChange: (point: CustomLodgingPoint | null) => void;
  onPickOnMap: () => void;
}> = ({ day, choice, onChoosePlace, onChooseCustom, onCustomPointChange, onPickOnMap }) => (
  <div>
    <div className="flex items-center justify-between gap-2 px-0.5 pb-1.5">
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span
          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: dayColor(day.day - 1) }}
        />
        <span className="text-[11px] font-bold uppercase tracking-wide text-[#f2ede3] font-mono flex-shrink-0">
          День {day.day}
        </span>
        <span className="text-[11px] font-mono text-[#8b9199] flex-shrink-0">
          · ~{formatDuration(day.total_s)}
        </span>
        {day.end_point.near_stop_name && (
          <span className="text-[10px] text-[#5a5f66] truncate">
            · до {day.end_point.near_stop_name}
          </span>
        )}
      </div>
      {day.over_limit && (
        // Same either-cause flag as PlanPanel's badge (see its comment) —
        // day_split.py's over_limit no longer means "driving time" specifically.
        <span
          className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-[#c05640] font-mono flex-shrink-0"
          title="Этот день превышает лимит вождения или бодрствования"
        >
          <AlertTriangle size={10} className="flex-shrink-0" />
          день перегружен
        </span>
      )}
    </div>

    <div className="space-y-1.5">
      {day.lodging_options.length === 0 && (
        <p className="text-[11px] text-[#5a5f66] px-0.5 pb-1">Жильё не найдено для этого дня.</p>
      )}
      {day.lodging_options.map((option) => (
        <LodgingCard
          key={option.place_id}
          option={option}
          dayNumber={day.day}
          isSelected={choice?.kind === 'place' && choice.option.place_id === option.place_id}
          onSelect={() => onChoosePlace(option)}
        />
      ))}
      <CustomLodgingCard
        dayNumber={day.day}
        endPoint={day.end_point}
        isSelected={choice?.kind === 'custom'}
        point={choice?.kind === 'custom' ? choice.point : null}
        onChoose={onChooseCustom}
        onPointChange={onCustomPointChange}
        onPickOnMap={onPickOnMap}
      />
    </div>
  </div>
);

// Sits between the free preview (finalize-preview) and the paywall/confirm
// step — shown only when needs_selection is true (App.tsx skips straight to
// the paywall/confirm otherwise). Selection lives in this component's own
// state, not draft_state: it's a one-time choice for THIS finalize attempt,
// not part of the editable draft.
export const LodgingSelectionModal: React.FC<LodgingSelectionModalProps> = ({
  isOpen, days, onContinue, onSkip, onCancel, onPickOnMap, mapPickResult, onMapPickResultConsumed,
  existingLodging,
}) => {
  const [choiceByDay, setChoiceByDay] = useState<Map<number, LodgingChoice>>(new Map());

  // Re-initializes whenever a fresh preview comes in — the modal stays
  // mounted (only its CSS visibility toggles, same pattern as the other
  // modals here), so without this a second finalize attempt would reopen
  // with stale selections from the last one. Defaults to "first option per
  // day"; existingLodging (re-lodging an already-finalized trip) overrides
  // that per-day with whatever was actually picked last time, when present.
  // A custom point is always restorable (its own always-rendered card
  // doesn't depend on this preview's candidates); a Places pick only
  // restores if that SAME place_id still appears among the fresh
  // day.lodging_options — otherwise falls back to "first option", same as
  // a day with no prior pick at all, rather than pre-selecting something
  // with no visible matching card.
  useEffect(() => {
    const existingByDay = new Map<number, ExistingLodgingEntry>((existingLodging ?? []).map((e) => [e.day, e]));
    const initial = new Map<number, LodgingChoice>();
    for (const day of days) {
      const existing = existingByDay.get(day.day);
      if (existing?.custom) {
        initial.set(day.day, {
          kind: 'custom',
          point: { lat: existing.lat, lon: existing.lon, name: existing.name },
        });
        continue;
      }
      if (existing && !existing.custom) {
        const matched = day.lodging_options.find((o) => o.place_id === existing.place_id);
        if (matched) {
          initial.set(day.day, { kind: 'place', option: matched });
          continue;
        }
      }
      if (day.lodging_options.length > 0) {
        initial.set(day.day, { kind: 'place', option: day.lodging_options[0] });
      }
    }
    setChoiceByDay(initial);
  }, [days, existingLodging]);

  // Applies a map-picked point (App.tsx's handleLodgingMapPick) to the day it
  // was picked for, then hands the relay slot back — the modal itself stayed
  // mounted the whole time this was in flight (isOpen just toggled off).
  useEffect(() => {
    if (!mapPickResult) return;
    setChoiceByDay((prev) => {
      const next = new Map<number, LodgingChoice>(prev);
      next.set(mapPickResult.day, {
        kind: 'custom',
        point: { lat: mapPickResult.lat, lon: mapPickResult.lon, name: mapPickResult.name },
      });
      return next;
    });
    onMapPickResultConsumed();
  }, [mapPickResult, onMapPickResultConsumed]);

  const pickableDays = days.slice(0, -1); // last day never gets a night after it

  const handleContinue = () => {
    const selected: SelectedLodging[] = [];
    for (const day of pickableDays) {
      const choice = choiceByDay.get(day.day);
      if (!choice) continue;
      if (choice.kind === 'place') {
        const option = choice.option;
        selected.push({
          day: day.day,
          place_id: option.place_id,
          lat: option.lat,
          lon: option.lon,
          name: option.name,
          rating: option.rating,
          vicinity: option.vicinity,
          custom: false,
        });
      } else if (choice.point) {
        selected.push({
          day: day.day,
          place_id: null,
          lat: choice.point.lat,
          lon: choice.point.lon,
          name: choice.point.name,
          rating: null,
          vicinity: null,
          custom: true,
        });
      }
      // choice.kind === 'custom' with point === null: radio picked but
      // nothing entered yet — same as no selection for this day, skipped.
    }
    onContinue(selected);
  };

  return (
    <div className={`modal ${isOpen ? 'on' : ''}`}>
      <div className="modal-box" style={{ width: 560, maxWidth: '94vw' }}>
        <div className="flex items-center justify-between mb-1">
          <h2>Выберите ночёвки</h2>
          <button
            onClick={onCancel}
            className="text-[#8b9199] hover:text-[#f2ede3] text-lg leading-none cursor-pointer"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>
        <p className="text-[11px] text-[#8b9199] -mt-1 mb-3">
          {existingLodging
            // Re-lodging an already-finalized trip: days/times shown here
            // are already Google-exact (reused as-is from the current
            // version, not re-split) — what changes is the ROUTE, since a
            // picked night becomes a waypoint Directions is routed through.
            ? 'Границы дней — из текущей версии, маршрут пойдёт через выбранные ночёвки: время и границы уточнятся после финализации.'
            : 'Дни и время — по предварительной оценке, уточнятся после оплаты.'}
        </p>

        <div className="max-h-[55vh] overflow-y-auto space-y-4 pr-1">
          {pickableDays.map((day) => (
            <DayLodgingSection
              key={day.day}
              day={day}
              choice={choiceByDay.get(day.day)}
              onChoosePlace={(option) => {
                setChoiceByDay((prev) => {
                  const next = new Map<number, LodgingChoice>(prev);
                  next.set(day.day, { kind: 'place', option });
                  return next;
                });
              }}
              onChooseCustom={() => {
                setChoiceByDay((prev) => {
                  const next = new Map<number, LodgingChoice>(prev);
                  const existing = next.get(day.day);
                  next.set(day.day, existing?.kind === 'custom' ? existing : { kind: 'custom', point: null });
                  return next;
                });
              }}
              onCustomPointChange={(point) => {
                setChoiceByDay((prev) => {
                  const next = new Map<number, LodgingChoice>(prev);
                  next.set(day.day, { kind: 'custom', point });
                  return next;
                });
              }}
              onPickOnMap={() => onPickOnMap(day.day)}
            />
          ))}
        </div>

        <div className="flex gap-3 justify-end mt-4">
          <button
            className="px-4 py-2 text-xs font-semibold rounded bg-[#3a4048] text-white hover:bg-opacity-80 cursor-pointer"
            onClick={onSkip}
          >
            Пропустить
          </button>
          <button
            className="px-4 py-2 text-xs font-semibold rounded bg-[#e8b53f] text-[#14171a] hover:bg-opacity-80 cursor-pointer"
            onClick={handleContinue}
          >
            Продолжить с выбранными
          </button>
        </div>
      </div>
    </div>
  );
};
