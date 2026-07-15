import React from 'react';

export interface GenerationProgressProps {
  currentStep: number; // 0-indexed active step (0 to 5)
}

export const GenerationProgress: React.FC<GenerationProgressProps> = ({ currentStep }) => {
  const steps = [
    "Строим базовый путь",
    "Делим поездку на дни",
    "Ищем остановки",
    "Считаем реальные крюки",
    "Проверяем ограничения",
    "Собираем план"
  ];

  return (
    <div className="gen" id="generation-progress">
      {steps.map((step, idx) => {
        let statusClass = '';
        if (idx < currentStep) {
          statusClass = 'done';
        } else if (idx === currentStep) {
          statusClass = 'act';
        }

        return (
          <div
            key={idx}
            className={`gen-step ${statusClass}`}
            id={`gs${idx}`}
          >
            <i />
            {step}
          </div>
        );
      })}
    </div>
  );
};
