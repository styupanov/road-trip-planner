import React, { useState, useEffect, useRef } from 'react';

export interface HeaderProps {
  tripTitle: string;
  // Driven by the real server autosave now (App.tsx), not localStorage —
  // 'unsaved' means a change just happened and the debounced save hasn't
  // fired yet, not "you'll lose this if you don't click Save" (there's no
  // manual Save anymore, saving is unconditional).
  saveState: 'saved' | 'saving' | 'unsaved';
  onTitleChange: (newTitle: string) => void;
  onNewTrip: () => void;
  // Фаза 2 auth state — whether the CURRENT session is linked to a Google
  // account (App.tsx's authState, from GET /auth/me). Not a separate login
  // system: same rtp_session cookie either way, see auth.py's claim logic.
  authenticated: boolean;
  userEmail: string | null;
  onLoginClick: () => void;
  onLogoutClick: () => void;
  // Opens "Мои поездки" if signed in, or the same sign-in modal if not —
  // App.tsx's handleMyTripsClick decides which, this button never checks
  // `authenticated` itself.
  onMyTripsClick: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  tripTitle,
  saveState,
  onTitleChange,
  onNewTrip,
  authenticated,
  userEmail,
  onLoginClick,
  onLogoutClick,
  onMyTripsClick,
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
        
        {/* Save Indicator — autosave is unconditional now, no manual Save button */}
        <span className={`font-mono text-[10px] select-none ${saveIndicatorClass}`}>
          {saveIndicatorText}
        </span>

        {/* Auth — email + Выйти once signed in, otherwise Войти (opens the
            same Google sign-in modal Finalize does, see App.tsx). */}
        {authenticated ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-[#8b9199] font-mono truncate max-w-[160px]" title={userEmail ?? undefined}>
              {userEmail}
            </span>
            <button
              onClick={onLogoutClick}
              className="px-3 py-1.5 text-xs font-semibold rounded bg-[#2c3138] border border-[#3a4048] text-[#f2ede3] hover:bg-[#3a4048] transition-colors cursor-pointer"
            >
              Выйти
            </button>
          </div>
        ) : (
          <button
            onClick={onLoginClick}
            className="px-3 py-1.5 text-xs font-semibold rounded bg-[#2c3138] border border-[#3a4048] text-[#f2ede3] hover:bg-[#3a4048] transition-colors cursor-pointer"
          >
            Войти
          </button>
        )}

        {/* My Trips — live now (Фаза 2, шаг 3). Not signed in yet? clicking
            still works, App.tsx's handleMyTripsClick routes to the sign-in
            modal instead of the list. */}
        <button
          onClick={onMyTripsClick}
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
