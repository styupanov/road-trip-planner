import React, { useState, useEffect, useRef } from 'react';

export interface HeaderProps {
  tripTitle: string;
  saveState: 'saved' | 'saving' | 'unsaved';
  hasChanges: boolean;
  onSave: () => void;
  onTitleChange: (newTitle: string) => void;
  onOpenTrips: () => void;
  onNewTrip: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  tripTitle,
  saveState,
  hasChanges,
  onSave,
  onTitleChange,
  onOpenTrips,
  onNewTrip,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editVal, setEditVal] = useState(tripTitle);
  const inputRef = useRef<HTMLInputElement>(null);

  // Synchronize when tripTitle changes externally
  useEffect(() => {
    setEditVal(tripTitle);
  }, [tripTitle]);

  const handleStartEdit = () => {
    setIsEditing(true);
    setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 50);
  };

  const handleFinishEdit = () => {
    setIsEditing(false);
    const trimmed = editVal.trim();
    if (trimmed && trimmed !== tripTitle) {
      onTitleChange(trimmed);
    } else {
      setEditVal(tripTitle);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleFinishEdit();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
      setEditVal(tripTitle);
    }
  };

  // Determine save indicator text and style
  let saveIndicatorText = 'Сохранено';
  let saveIndicatorClass = 'text-[#8b9199]'; // var(--muted)

  if (saveState === 'saving') {
    saveIndicatorText = 'Сохранение…';
    saveIndicatorClass = 'text-[#8b9199] animate-pulse';
  } else if (saveState === 'unsaved') {
    saveIndicatorText = 'Не сохранено';
    saveIndicatorClass = 'text-[#e8b53f]'; // var(--yellow)
  }

  return (
    <header className="w-full bg-[#14171a] border-b border-black py-3 px-5 flex flex-col sm:flex-row items-center justify-between gap-4 z-40 flex-shrink-0">
      
      {/* Left: Logo */}
      <div className="flex items-center gap-2 flex-shrink-0">
        <span 
          className="text-white font-semibold select-none cursor-default"
          style={{ fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.14em' }}
        >
          Road Trip Planner
        </span>
      </div>

      {/* Center: Editable title inline */}
      <div className="flex-1 flex justify-center max-w-full sm:max-w-[40%] md:max-w-[50%] px-2">
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            value={editVal}
            onChange={(e) => setEditVal(e.target.value)}
            onBlur={handleFinishEdit}
            onKeyDown={handleKeyDown}
            className="w-full text-center bg-[#2c3138] border border-[#e8b53f] text-[#f2ede3] px-3 py-1 rounded text-sm font-medium focus:outline-none"
            maxLength={60}
          />
        ) : (
          <div
            onClick={handleStartEdit}
            className="text-sm font-medium text-[#f2ede3] hover:text-[#e8b53f] cursor-pointer text-center px-3 py-1 rounded hover:bg-[#2c3138] transition-all truncate max-w-full"
            title="Нажмите, чтобы изменить название поездки"
          >
            {tripTitle || 'Без названия'}
          </div>
        )}
      </div>

      {/* Right Actions */}
      <div className="flex items-center gap-3.5 flex-shrink-0">
        
        {/* Save Indicator */}
        <span className={`font-mono text-[10px] select-none ${saveIndicatorClass}`}>
          {saveIndicatorText}
        </span>

        {/* Save Button (shows only when hasChanges or unsaved) */}
        {hasChanges && (
          <button
            onClick={onSave}
            className="px-3 py-1.5 text-xs font-semibold rounded bg-[#e8b53f] text-[#14171a] hover:bg-[#d4a230] transition-colors cursor-pointer"
          >
            Сохранить
          </button>
        )}

        {/* My Trips Button */}
        <button
          onClick={onOpenTrips}
          className="px-3 py-1.5 text-xs font-semibold rounded bg-[#2c3138] border border-[#3a4048] text-[#f2ede3] hover:bg-[#3a4048] transition-colors cursor-pointer"
        >
          Мои поездки
        </button>

        {/* New Trip Button */}
        <button
          onClick={onNewTrip}
          className="px-3 py-1.5 text-xs font-semibold rounded bg-[#2c3138] border border-[#3a4048] text-[#f2ede3] hover:bg-[#3a4048] transition-colors cursor-pointer"
        >
          Новая поездка
        </button>

      </div>

    </header>
  );
};
