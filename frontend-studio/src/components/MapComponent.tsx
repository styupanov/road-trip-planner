import React from 'react';
import { TripMap, PlanMapMarker } from './TripMap';

interface MapComponentProps {
  // 'finalizing' renders exactly like 'plan' (see App.tsx's call site, which
  // passes the pre-finalize plan overlay through unchanged so the map stays
  // put while the progress screen runs alongside it). 'finalized' gets its
  // own overlay data, derived from the snapshot instead of the live draft.
  phase: 'quiz' | 'refine' | 'generating' | 'plan' | 'finalizing' | 'finalized';
  generationStep: number;
  routeLine: Array<{ lat: number; lng: number }>;
  originCoord: { lat: number; lng: number } | null;
  destCoord: { lat: number; lng: number } | null;
  onOriginDragEnd: (lat: number, lng: number) => void;
  onDestDragEnd: (lat: number, lng: number) => void;
  pickingField: 'origin' | 'dest' | null;
  onMapClick: (lat: number, lng: number) => void;
  planRouteLines: Array<{ points: Array<{ lat: number; lng: number }>; isActive: boolean }>;
  planMarkers: PlanMapMarker[];
  // Day-colored replacement for the active option's line in planRouteLines —
  // only non-empty once /detail-route has run for it (see App.tsx comment).
  activeDaySegments: Array<{ points: Array<{ lat: number; lng: number }>; color: string }>;
  dayBoundaryMarkers: Array<{ position: { lat: number; lng: number }; color: string; label: string }>;
  // Фаза ночёвок: only ever populated in phase 'finalized' (a snapshot's
  // chosen lodging) — App.tsx passes [] for every other phase.
  lodgingMarkers: Array<{ position: { lat: number; lng: number }; name: string }>;
  selectedStopId: number | null;
  onSelectStop: (id: number) => void;
  onClosePopup: () => void;
  onToggleStop: (id: number) => void;
}

export const MapComponent: React.FC<MapComponentProps> = ({
  phase,
  generationStep,
  routeLine,
  originCoord,
  destCoord,
  onOriginDragEnd,
  onDestDragEnd,
  pickingField,
  onMapClick,
  planRouteLines,
  planMarkers,
  activeDaySegments,
  dayBoundaryMarkers,
  lodgingMarkers,
  selectedStopId,
  onSelectStop,
  onClosePopup,
  onToggleStop
}) => {
  // 'generating' shows a live single-line preview while the plan overlay isn't
  // ready yet; 'plan'/'finalizing' (same overlay, see prop comment above) and
  // 'finalized' switch entirely to the multi-option/snapshot overlay below.
  const drawPath = phase === 'generating' && generationStep >= 0;
  const showOverlay = phase === 'plan' || phase === 'finalizing' || phase === 'finalized';

  return (
    <div className="relative w-full h-full">
      <TripMap
        drawPath={drawPath}
        path={routeLine}
        originCoord={originCoord}
        destCoord={destCoord}
        onOriginDragEnd={onOriginDragEnd}
        onDestDragEnd={onDestDragEnd}
        pickingField={pickingField}
        onMapClick={onMapClick}
        planRouteLines={showOverlay ? planRouteLines : []}
        planMarkers={showOverlay ? planMarkers : []}
        activeDaySegments={showOverlay ? activeDaySegments : []}
        dayBoundaryMarkers={showOverlay ? dayBoundaryMarkers : []}
        lodgingMarkers={showOverlay ? lodgingMarkers : []}
        selectedStopId={selectedStopId}
        onSelectStop={onSelectStop}
        onClosePopup={onClosePopup}
        onToggleStop={onToggleStop}
        readOnly={phase === 'finalized' || phase === 'finalizing'}
      />
    </div>
  );
};
