export const formatDuration = (totalSeconds: number): string => {
  const totalMinutes = Math.round(Math.max(0, totalSeconds) / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h === 0 ? `${m} мин` : `${h} ч ${m} мин`;
};

// detour_s is a single-stop estimate vs the direct route. It is NOT additive across
// stops sharing a road — stops on the same detour "split" it, so sum(detour_s) !=
// delta_s of the actual multi-stop route (see RouteThroughResult.delta_s /
// RouteOption.delta_s). Deliberately never starts with "+<number>": that reads as
// a summand, and several of these in a row get added up by eye even when the
// wording says not to. delta_s (shown once, prominently, elsewhere) is the only
// real total.
export const formatDetour = (detourS: number): string => {
  if (detourS < 60) return 'по пути';
  return `крюк в одиночку: ${Math.round(detourS / 60)} мин`;
};

// Russian plural forms for "день" (день/дня/дней) — the day-split fits_plan
// banner and day-group headers both need this, not just date ranges below.
export const formatDaysRu = (n: number): string => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  const word = mod100 >= 11 && mod100 <= 14 ? 'дней' : mod10 === 1 ? 'день' : mod10 >= 2 && mod10 <= 4 ? 'дня' : 'дней';
  return `${n} ${word}`;
};

const RU_MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

// Formats two <input type="date"> ISO values ("YYYY-MM-DD") into a Russian
// date range for trip_dates, e.g. "12–15 сентября 2026" (en dash, per the
// existing convention) when both dates share a month/year — falls back to
// spelling out the month (and year) on each side when they don't, so a
// cross-month/cross-year pick still reads correctly instead of lying about it.
export const formatDateRangeRu = (fromIso: string, toIso: string): string => {
  const from = new Date(`${fromIso}T00:00:00`);
  const to = new Date(`${toIso}T00:00:00`);

  const toStr = `${to.getDate()} ${RU_MONTHS_GENITIVE[to.getMonth()]} ${to.getFullYear()}`;

  if (from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth()) {
    return `${from.getDate()}–${toStr}`;
  }

  const fromMonth = RU_MONTHS_GENITIVE[from.getMonth()];
  if (from.getFullYear() === to.getFullYear()) {
    return `${from.getDate()} ${fromMonth} – ${toStr}`;
  }
  return `${from.getDate()} ${fromMonth} ${from.getFullYear()} – ${toStr}`;
};
