import React, { useEffect, useState } from 'react';

const STAGES = [
  'Проверяем маршрут',
  'Строим финальные сегменты',
  'Готовим гид',
  'Сохраняем поездку',
];

// Rough per-stage pacing that adds up to ~15-20s (real detailing is Google
// Directions + day split + two Gemini calls, see finalize.py) — purely
// cosmetic. The ACTUAL transition away from this screen is driven by the
// polled job status in App.tsx, never by this timer running out; it just
// holds on the last stage if the real work takes longer than the animation.
const STAGE_DURATIONS_MS = [3000, 4000, 8000, 3000];

export const FinalizeProgress: React.FC = () => {
  const [stageIndex, setStageIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];

    let elapsed = 0;
    for (let i = 0; i < STAGE_DURATIONS_MS.length - 1; i++) {
      elapsed += STAGE_DURATIONS_MS[i];
      const targetIndex = i + 1;
      timers.push(setTimeout(() => {
        if (!cancelled) setStageIndex(targetIndex);
      }, elapsed));
    }

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="gen" id="finalize-progress">
      {STAGES.map((label, idx) => {
        let statusClass = '';
        if (idx < stageIndex) statusClass = 'done';
        else if (idx === stageIndex) statusClass = 'act';
        return (
          <div key={idx} className={`gen-step ${statusClass}`}>
            <i />
            {label}
          </div>
        );
      })}
      <p className="text-[11px] text-[#8b9199] leading-snug mt-3">
        Обычно занимает 15–20 секунд. Можно закрыть вкладку — поездка досчитается
        на сервере и появится в «Мои поездки» уже финализированной.
      </p>
    </div>
  );
};
