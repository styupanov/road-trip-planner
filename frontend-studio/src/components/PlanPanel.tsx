import React from 'react';
import { Info, Calendar, ArrowUpRight, AlertTriangle } from 'lucide-react';
import { ApiStop, DayResult, RouteOption, DetailRouteResult, EnrichRouteResult, EnrichedStop } from '../api';
import { formatDuration, formatDetour, formatDaysRu } from '../format';
import { dayColor } from '../dayColors';

export interface RouteThroughSummary {
  total_s: number;
  delta_s: number;
  through_shape: string;
}

export interface PlanPanelProps {
  options: RouteOption[];
  activeOptionIndex: number;
  onSelectTab: (index: number) => void;
  includedByOption: Map<number, Set<number>>;
  onToggleStop: (stopId: number) => void;
  routeThroughByOption: Map<number, RouteThroughSummary>;
  // Is a /route-through request currently in flight FOR the active option
  // specifically — a request for a different (now inactive) tab doesn't count.
  isRecomputing: boolean;
  selectedStopId: number | null;
  onSelectStop: (id: number) => void;
  // Per-option Google Directions result — exact numbers, distinct from the
  // Valhalla-estimated routeThroughByOption above. Never mix the two sources in
  // one subtraction (see the delta_s comment below).
  //
  // Фаза 1 финальный шаг: detailedByOption/enrichedByOption stay wired all the
  // way through (day-grouping, colored map segments, why/tips/dates_note cards,
  // sources — none of that code was touched) but nothing populates them from
  // the free flow anymore — the "Детализировать"/"Рассказать о маршруте"
  // buttons that used to trigger /detail-route and /enrich-route are gone,
  // replaced by the single Finalize button below. Both maps are therefore
  // always empty here today, which is exactly why the flat stop list and the
  // single-color route render — that fallback was always the "no detail yet"
  // path, it just used to be temporary. Фаза 3's Finalize repopulates these
  // same maps after a real credit charge and everything downstream just works.
  detailedByOption: Map<number, DetailRouteResult>;
  enrichedByOption: Map<number, EnrichRouteResult>;
  onFinalizeClick: () => void;
  // Фаза ночёвок: the free finalize-preview call is in flight (between the
  // click and the lodging picker/paywall showing up) — disables the button
  // and swaps its label so a slow response doesn't read as a dead click.
  finalizePreviewLoading: boolean;
}

const PlanStopRow: React.FC<{
  stop: ApiStop;
  isSelected: boolean;
  isIncluded: boolean;
  order: number | null;
  enrichment: EnrichedStop | null;
  onSelectStop: (id: number) => void;
  onToggleStop: (id: number) => void;
}> = ({ stop, isSelected, isIncluded, order, enrichment, onSelectStop, onToggleStop }) => (
  <div
    onClick={() => onSelectStop(stop.id)}
    className={`w-full text-left p-2.5 rounded transition-colors cursor-pointer border flex gap-2.5 ${
      isSelected
        ? 'bg-[#2c3138] border-[#e8b53f]'
        : 'bg-[#1a1d21] border-transparent hover:bg-[#22262b]'
    } ${!isIncluded ? 'opacity-50' : ''}`}
  >
    <input
      type="checkbox"
      checked={isIncluded}
      onClick={(e) => e.stopPropagation()}
      onChange={() => onToggleStop(stop.id)}
      className="mt-0.5 flex-shrink-0 accent-[#e8b53f] cursor-pointer"
    />
    {order !== null && (
      <span className="mt-0.5 flex-shrink-0 w-[26px] h-[26px] rounded-full bg-[#e8b53f] text-[#14171a] text-[12px] font-bold flex items-center justify-center">
        {order}
      </span>
    )}
    <div className="min-w-0 flex-1">
      {/* ШАПКА: router/POI-database facts — plain, no source link, because it's
          already verified. */}
      <div className="text-[11px] uppercase tracking-wide text-[#8b9199] font-mono truncate">
        {stop.category}
      </div>
      <div className="text-[17px] font-medium text-[#f2ede3] leading-tight mt-0.5 truncate">
        {stop.name}
      </div>
      <div className="flex items-center justify-between mt-1.5 gap-2">
        <span className="text-[11px] font-mono text-[#8b9199] flex-shrink-0">
          {stop.rating != null ? `★ ${stop.rating.toFixed(1)}` : 'без рейтинга'}
          {stop.review_count != null ? ` · ${stop.review_count}` : ''}
        </span>
        <span className="text-[11px] font-mono text-[#8b9199] flex items-center gap-1 text-right flex-shrink-0">
          {formatDetour(stop.detour_s)}
          <ArrowUpRight size={11} className="flex-shrink-0" />
        </span>
      </div>

      {/* ПРИНЦИП РАЗДЕЛЕНИЯ: the divider below is the visual boundary between
          verified router/POI facts (above) and Gemini-authored text (below) —
          only rendered when there's enrichment content to divide from the facts,
          so a not-yet-enriched card never shows an empty rule under its header.
          One accent per card, deliberately: the dates_note plate. why reads
          plain/primary (it's the substance), tips is quiet (icon, no label). */}
      {enrichment && (
        <div className="mt-2.5 pt-2.5 border-t-[0.5px] border-[#2c3138] space-y-2">
          <p className="text-[14px] text-[#f2ede3] leading-snug">{enrichment.why}</p>

          {enrichment.tips && (
            <div className="flex gap-1.5 items-start" onClick={(e) => e.stopPropagation()}>
              <Info size={13} className="text-[#8b9199] flex-shrink-0 mt-0.5" />
              <p className="text-[13px] text-[#c7cdd4] leading-snug">{enrichment.tips}</p>
            </div>
          )}

          {enrichment.dates_note && (
            <div
              className="px-2.5 py-2 rounded bg-[#e8b53f]/10 border border-[#e8b53f]/25"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-[#e8b53f] font-mono mb-1">
                <Calendar size={11} className="flex-shrink-0" />
                по данным поиска
              </div>
              <p className="text-[12px] text-[#c7cdd4] leading-snug">{enrichment.dates_note}</p>
            </div>
          )}
        </div>
      )}
    </div>
  </div>
);

const DayGroupHeader: React.FC<{ day: DayResult; lastStopName: string | null }> = ({ day, lastStopName }) => (
  <div className="flex items-center justify-between gap-2 px-0.5 pt-1 pb-1.5">
    <div className="flex items-baseline gap-1.5 min-w-0">
      {/* Same color the map uses for this day's route segment (dayColor.ts) —
          this dot is what ties a card group here to a colored line there. */}
      <span
        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: dayColor(day.day - 1) }}
      />
      <span className="text-[11px] font-bold uppercase tracking-wide text-[#f2ede3] font-mono flex-shrink-0">
        День {day.day}
      </span>
      {/* Tilde is mandatory here, not decorative: total_s = drive_s (exact,
          Google) + visit_s (flat 1h/stop guess, see DayResult in api.ts). Once
          visit time is per-stop instead of a constant, this still just reads
          the same day.total_s field — nothing here has to change. */}
      <span className="text-[11px] font-mono text-[#8b9199] flex-shrink-0">
        · ~{formatDuration(day.total_s)}
      </span>
      {lastStopName && (
        <span className="text-[10px] text-[#5a5f66] truncate">· ≈ район {lastStopName}</span>
      )}
    </div>
    {day.over_limit && (
      <span
        className="flex items-center gap-1 text-[9px] uppercase tracking-wide text-[#c05640] font-mono flex-shrink-0"
        title="Переезд в этот день длиннее заданного лимита вождения"
      >
        <AlertTriangle size={10} className="flex-shrink-0" />
        длинный переезд
      </span>
    )}
  </div>
);

export const PlanPanel: React.FC<PlanPanelProps> = ({
  options,
  activeOptionIndex,
  onSelectTab,
  includedByOption,
  onToggleStop,
  routeThroughByOption,
  isRecomputing,
  selectedStopId,
  onSelectStop,
  detailedByOption,
  enrichedByOption,
  onFinalizeClick,
  finalizePreviewLoading,
}) => {
  const active = options[activeOptionIndex];

  if (!active) {
    return (
      <aside className="w-[min(560px,40vw)] h-full flex flex-col items-center justify-center bg-[#14171a] border-l border-black overflow-hidden p-4">
        <p className="text-[12px] text-[#8b9199] text-center">Не удалось построить маршрут.</p>
      </aside>
    );
  }

  const included = includedByOption.get(activeOptionIndex) ?? new Set<number>();
  const includedStops = active.stops
    .filter(s => included.has(s.id))
    .sort((a, b) => a.to_poi_s - b.to_poi_s);
  const otherStops = active.stops
    .filter(s => !included.has(s.id))
    .sort((a, b) => a.to_poi_s - b.to_poi_s);
  const orderById = new Map(includedStops.map((s, i) => [s.id, i + 1]));

  const through = routeThroughByOption.get(activeOptionIndex);
  const detail = detailedByOption.get(activeOptionIndex);
  // detail (Google) always wins when present — it's exact, not an estimate. Never
  // combine a Google number with a Valhalla one in the same subtraction: Valhalla
  // runs ~30-46% over real-world driving time, so e.g. "Google total_s minus
  // Valhalla baseline_s" would be comparing two different measuring sticks and
  // produce a meaningless delta. delta_s below always comes whole from one source.
  const totalS = detail?.duration_s ?? through?.total_s ?? active.total_s ?? active.duration_s;
  const deltaS = detail?.delta_s ?? through?.delta_s ?? active.delta_s;
  const distanceKm = detail?.distance_km ?? active.distance_km;
  const isExact = detail != null;

  const enrichment = enrichedByOption.get(activeOptionIndex);
  const enrichmentById = new Map((enrichment?.stops ?? []).map(s => [s.id, s]));

  return (
    <aside className="w-[min(560px,40vw)] h-full flex flex-col bg-[#14171a] border-l border-black overflow-hidden">
      {options.length > 1 && (
        <div className="flex gap-1.5 px-2.5 py-2.5 border-b border-black flex-shrink-0">
          {options.map((option, idx) => (
            <button
              key={option.index}
              onClick={() => onSelectTab(idx)}
              className={`flex-1 px-2 py-2 rounded text-[11px] font-mono font-semibold uppercase tracking-wide transition-colors cursor-pointer border ${
                idx === activeOptionIndex
                  ? 'bg-[#e8b53f] text-[#14171a] border-[#e8b53f]'
                  : 'bg-[#2c3138] text-[#8b9199] border-transparent hover:bg-[#3a4048]'
              }`}
            >
              Вариант {idx + 1}
            </button>
          ))}
        </div>
      )}

      <div className={`px-4 py-3 border-b border-black flex-shrink-0 transition-opacity ${isRecomputing ? 'opacity-60' : ''}`}>
        <div className="text-[11px] font-mono text-[#8b9199]">
          {formatDuration(totalS)} · {Math.round(distanceKm)} км{' '}
          {/* Valhalla's drive-time estimate runs ~30-46% over real-world driving (see
              CLAUDE.md) — muted "(оценка)" flags the absolute number as approximate.
              Once /detail-route has been called for this option, the numbers above
              are Google's exact ones instead, and the label switches to "(Google)". */}
          <span className="text-[10px]">{isExact ? '(Google)' : '(оценка)'}</span>
        </div>
        {/* delta_s is the ONE honest total — a real Valhalla route through every
            included stop, not a sum of individual detour_s (see formatDetour in
            format.ts). It's the dominant figure in this block on purpose, so it
            reads as the answer, not one number among several. */}
        <div className="mt-1">
          {deltaS != null ? (
            <span className="text-[22px] font-bold text-[#e8b53f] leading-none">
              +{formatDuration(deltaS)}
            </span>
          ) : (
            <span className="text-[13px] text-[#8b9199]">крюк ещё не посчитан</span>
          )}
        </div>
        {deltaS != null && (
          <div className="text-[11px] font-mono text-[#8b9199] mt-0.5">к прямому пути</div>
        )}
        <div className="text-[11px] font-mono text-[#8b9199] mt-1.5">
          {includedStops.length} остановок
          {active.avg_rating != null ? ` · рейтинг ${active.avg_rating.toFixed(1)}` : ''}
        </div>
        {isRecomputing && (
          <div className="text-[10px] font-mono text-[#8b9199] mt-1">Пересчитываем…</div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2.5 space-y-1.5">
        {enrichment && (
          <div className="mb-1">
            <p className="text-[11px] text-[#c7cdd4] leading-snug">{enrichment.overview}</p>
            {enrichment.warnings.length > 0 && (
              <div className="mt-2 space-y-1">
                {enrichment.warnings.map((w, i) => (
                  <div
                    key={i}
                    className="flex gap-1.5 px-2 py-1.5 rounded bg-[#2a1f1a] border-l-2 border-[#c05640]"
                  >
                    <span className="text-[#c05640] text-[11px] flex-shrink-0">⚠</span>
                    <p className="text-[11px] text-[#d8a898] leading-snug">{w}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Day grouping only exists once /detail-route has run — that's the only
            source of Google-accurate legs day_split needs (see day_split.py /
            DetailRouteResult.days comment in api.ts). Before that, a flat list
            by route order, same as always. As of Фаза 1's final step, "before
            that" is now permanent for the free draft — detail only ever gets
            populated by Finalize (Фаза 3), never by this screen directly. */}
        {detail && detail.fits_plan != null && (
          detail.fits_plan ? (
            <p className="text-[10px] text-[#5a5f66] mb-2 px-0.5">
              Укладывается в {formatDaysRu(detail.planned_days as number)}
            </p>
          ) : (
            <div className="flex gap-1.5 mb-2 px-2.5 py-2 rounded bg-[#2c3138] border-l-2 border-[#e8b53f]">
              <Calendar size={13} className="text-[#e8b53f] flex-shrink-0 mt-0.5" />
              <p className="text-[12px] text-[#f2ede3] leading-snug">
                Маршрут занимает {formatDaysRu(detail.actual_days)} при вашем лимите вождения.
                Вы планировали {formatDaysRu(detail.planned_days as number)}.
              </p>
            </div>
          )
        )}

        {detail ? (
          detail.days.map((day) => {
            const dayStops = day.stop_indices
              .map((idx) => includedStops[idx])
              .filter((s): s is ApiStop => s != null);
            const lastStopName = dayStops.length > 0 ? dayStops[dayStops.length - 1].name : null;

            return (
              <div key={day.day}>
                <DayGroupHeader day={day} lastStopName={lastStopName} />
                <div className="space-y-1.5">
                  {dayStops.map((stop) => (
                    <PlanStopRow
                      key={stop.id}
                      stop={stop}
                      isSelected={selectedStopId === stop.id}
                      isIncluded={true}
                      order={orderById.get(stop.id) ?? null}
                      enrichment={enrichmentById.get(stop.id) ?? null}
                      onSelectStop={onSelectStop}
                      onToggleStop={onToggleStop}
                    />
                  ))}
                </div>
              </div>
            );
          })
        ) : (
          includedStops.map((stop) => (
            <PlanStopRow
              key={stop.id}
              stop={stop}
              isSelected={selectedStopId === stop.id}
              isIncluded={true}
              order={orderById.get(stop.id) ?? null}
              enrichment={enrichmentById.get(stop.id) ?? null}
              onSelectStop={onSelectStop}
              onToggleStop={onToggleStop}
            />
          ))
        )}

        {otherStops.length > 0 && (
          <>
            <div className="text-[10px] font-semibold text-[#8b9199] uppercase tracking-wider pt-2 pb-0.5 px-0.5">
              Ещё рядом
            </div>
            {otherStops.map((stop) => (
              <PlanStopRow
                key={stop.id}
                stop={stop}
                isSelected={selectedStopId === stop.id}
                isIncluded={false}
                order={null}
                enrichment={null}
                onSelectStop={onSelectStop}
                onToggleStop={onToggleStop}
              />
            ))}
          </>
        )}

        {active.stops.length === 0 && (
          <p className="text-[12px] text-[#8b9199] text-center mt-4">Подходящих остановок не нашлось.</p>
        )}

        {/* Flat list, not attributed to individual stops — see EnrichSource comment
            in api.ts for why per-stop attribution was dropped. */}
        {enrichment && enrichment.sources.length > 0 && (
          <div className="mt-3 pt-2.5 border-t border-[#2c3138]">
            <div className="text-[9px] uppercase tracking-wide text-[#5a5f66] font-mono mb-1 px-0.5">
              Источники
            </div>
            <div className="flex flex-col gap-1 px-0.5">
              {enrichment.sources.map((source, i) => (
                <a
                  key={i}
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] text-[#6a9fd8] hover:underline truncate"
                >
                  {source.title}
                </a>
              ))}
            </div>
          </div>
        )}
      </div>

      {active.stops.length > 0 && (
        <div className="px-3 py-2 border-t border-black flex-shrink-0">
          <p className="text-[10px] text-[#5a5f66] leading-snug">
            Крюк на карточках — стоимость заезда по отдельности. Итог сверху — реальное время маршрута через все выбранные.
          </p>
        </div>
      )}

      {/* Single paid entry point — replaces the old separate "Детализировать"
          (/detail-route) and "Рассказать о маршруте" (/enrich-route) buttons.
          Both are now Finalize-only (Фаза 3): one credit unlocks exact Google
          timing, the day split, and the AI write-up together, not piecemeal.
          Deliberately no price/credit mention here — the user hasn't seen
          Finalize's value yet, a price tag this early is a wall in front of
          unproven value and hurts conversion. Credits get introduced later,
          after a first result (Фаза 3's welcome mechanic), not here. */}
      <div className="p-2.5 border-t border-black flex-shrink-0">
        <button
          onClick={onFinalizeClick}
          disabled={finalizePreviewLoading}
          className="w-full px-3 py-3 rounded text-[13px] font-semibold bg-[#e8b53f] text-[#14171a] hover:bg-[#d4a230] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-default"
        >
          {finalizePreviewLoading ? 'Готовим варианты…' : 'Финализировать поездку'}
        </button>
        <p className="text-[10px] text-[#8b9199] leading-snug mt-1.5 text-center">
          Точное время маршрута от Google, разбивка по дням, AI-гид по остановкам и датам, финальное сохранение поездки.
        </p>
      </div>
    </aside>
  );
};
