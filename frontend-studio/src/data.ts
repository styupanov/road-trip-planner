import { QuizQuestion } from './types';

export const QUIZ: QuizQuestion[] = [
  { k: "origin", q: "Откуда начинается поездка?", type: "text", ph: "Денвер, Колорадо", def: "Денвер" },
  // Asked BEFORE "dest" on purpose — round-trip's dest question (App.tsx)
  // reads this answer to swap its own label/placeholder ("куда доехать и
  // вернуться" vs "где заканчивается"), which only works if "trip" is
  // already in `answers` by the time "dest" renders.
  { k: "trip", q: "В одну сторону или туда и обратно?", type: "one", opts: ["В одну сторону", "Туда и обратно"] },
  { k: "dest", q: "Где заканчивается?", type: "text", ph: "Лас-Вегас, Невада", def: "Лас-Вегас" },
  { k: "days", q: "Сколько дней в запасе?", type: "days", def: 4 },
  { k: "drive", q: "Сколько готовы ехать в день?", type: "one", opts: ["до 3 ч", "до 4 ч", "до 6 ч", "не важно"], def: "до 4 ч" },
  { k: "detour", q: "Какой крюк ради места приемлем?", type: "one", opts: ["до 15 мин", "до 30 мин", "до 45 мин", "до часа"], def: "до 30 мин" },
  { k: "interests", q: "Что вам интересно?", type: "many", opts: ["каньоны", "горячие источники", "маленькие городки", "национальные парки", "смотровые", "необычные ландшафты", "история", "еда"] },
  { k: "pace", q: "Какой темп поездки?", type: "one", opts: ["спокойный", "сбалансированный", "насыщенный"], def: "спокойный" }
];
