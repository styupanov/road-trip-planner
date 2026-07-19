// Маппинг ответов квиза (src/data.ts -> QUIZ) на параметры запроса POST /stops.

type MaxDetourS = 900 | 1800 | 2700 | 3600;

const DETOUR_TO_MAX_DETOUR_S: Record<string, MaxDetourS> = {
  'до 15 мин': 900,
  'до 30 мин': 1800,
  'до 45 мин': 2700,
  'до часа': 3600,
};

const DEFAULT_MAX_DETOUR_S: MaxDetourS = 1800; // совпадает с def квиза для "detour"

export function mapDetourToMaxDetourS(detour: string | undefined): MaxDetourS {
  if (!detour) return DEFAULT_MAX_DETOUR_S;
  return DETOUR_TO_MAX_DETOUR_S[detour] ?? DEFAULT_MAX_DETOUR_S;
}

// В базе всего 19 TripAdvisor-категорий, а интересы квиза — свободные русские
// формулировки. Соответствие ниже неточное, это осознанное упрощение MVP:
// некоторые интересы (например, "маленькие городки") просто не имеют
// подходящей категории в данных.
const INTEREST_TO_CATEGORIES: Record<string, string[]> = {
  'каньоны': ['Nature & Parks', 'Sights & Landmarks'],
  'горячие источники': ['Spas & Wellness'],
  'национальные парки': ['Nature & Parks'],
  'смотровые': ['Nature & Parks', 'Sights & Landmarks'],
  'необычные ландшафты': ['Nature & Parks', 'Sights & Landmarks'],
  'история': ['Museums', 'Sights & Landmarks'],
  'еда': ['Food & Drink'],
  'маленькие городки': [],
};

const FALLBACK_CATEGORIES = ['Nature & Parks', 'Sights & Landmarks', 'Outdoor Activities', 'Museums'];

export function mapInterestsToCategories(interests: string[] | undefined): string[] {
  const categories = new Set<string>();
  for (const interest of interests ?? []) {
    for (const category of INTEREST_TO_CATEGORIES[interest] ?? []) {
      categories.add(category);
    }
  }

  return categories.size > 0 ? [...categories] : [...FALLBACK_CATEGORIES];
}

type DailyLimitS = 10800 | 14400 | 21600 | 28800;

const DRIVE_TO_DAILY_LIMIT_S: Record<string, DailyLimitS> = {
  'до 3 ч': 10800,
  'до 4 ч': 14400,
  'до 6 ч': 21600,
  'не важно': 28800, // soft ceiling, not "unlimited" — day_split still needs a bound
};

const DEFAULT_DAILY_LIMIT_S: DailyLimitS = 14400; // совпадает с def квиза для "drive" ("до 4 ч")

export function mapDriveToDailyLimitS(drive: string | undefined): DailyLimitS {
  if (!drive) return DEFAULT_DAILY_LIMIT_S;
  return DRIVE_TO_DAILY_LIMIT_S[drive] ?? DEFAULT_DAILY_LIMIT_S;
}

export type ApiPace = 'relaxed' | 'balanced' | 'packed';

const PACE_TO_API_PACE: Record<string, ApiPace> = {
  'спокойный': 'relaxed',
  'сбалансированный': 'balanced',
  'насыщенный': 'packed',
};

const DEFAULT_API_PACE: ApiPace = 'relaxed'; // совпадает с def квиза для "pace" ("спокойный")

export function mapPaceToApiPace(pace: string | undefined): ApiPace {
  if (!pace) return DEFAULT_API_PACE;
  return PACE_TO_API_PACE[pace] ?? DEFAULT_API_PACE;
}
