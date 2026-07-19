import React from 'react';
import { TripMap, PlanMapMarker } from './TripMap';

interface MapComponentProps {
  phase: 'quiz' | 'refine' | 'generating' | 'plan';
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
  selectedStopId,
  onSelectStop,
  onClosePopup,
  onToggleStop
}) => {
  // 'generating' shows a live single-line preview while the plan overlay isn't
  // ready yet; 'plan' switches entirely to the multi-option overlay below.
  const drawPath = phase === 'generating' && generationStep >= 0;

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
        planRouteLines={phase === 'plan' ? planRouteLines : []}
        planMarkers={phase === 'plan' ? planMarkers : []}
        activeDaySegments={phase === 'plan' ? activeDaySegments : []}
        dayBoundaryMarkers={phase === 'plan' ? dayBoundaryMarkers : []}
        selectedStopId={selectedStopId}
        onSelectStop={onSelectStop}
        onClosePopup={onClosePopup}
        onToggleStop={onToggleStop}
      />
    </div>
  );
};
