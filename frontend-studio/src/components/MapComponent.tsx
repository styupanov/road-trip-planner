import React from 'react';
import { TripMap, PlanMapMarker, LodgingMapMarker } from './TripMap';

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
  // See TripMap's own prop comment — independent of pickingField, drives
  // cursor/hint only, while a custom lodging point is being picked on the map.
  pickingLodging?: boolean;
  planRouteLines: Array<{ points: Array<{ lat: number; lng: number }>; isActive: boolean }>;
  planMarkers: PlanMapMarker[];
  // Day-colored replacement for the active option's line in planRouteLines —
  // only non-empty once /detail-route has run for it (see App.tsx comment).
  activeDaySegments: Array<{ points: Array<{ lat: number; lng: number }>; color: string; dayNumber: number }>;
  dayBoundaryMarkers: Array<{ position: { lat: number; lng: number }; color: string; label: string }>;
  // Фаза ночёвок: only ever populated in phase 'finalized' (a snapshot's
  // lodging data, selected + candidate options) — App.tsx passes [] for
  // every other phase.
  lodgingMarkers: LodgingMapMarker[];
  // Сворачиваемые дни (Фаза 3, показ): clicking a day's route segment on the
  // map expands/scrolls to it in FinalizedView. Only meaningful in phase
  // 'finalized' — passed through unconditionally, harmless elsewhere since
  // activeDaySegments itself is gated to showOverlay below.
  onSegmentClick?: (dayNumber: number) => void;
  highlightedDay?: number | null;
  selectedStopId: number | null;
  onSelectStop: (id: number) => void;
  selectedLodgingPlaceId: string | null;
  onSelectLodging: (placeId: string) => void;
  onClosePopup: () => void;
  onToggleStop: (id: number) => void;
  // Day isolation (finalized map only): true while a single day is
  // isolated — suppresses TripMap's autofit so hiding/restoring the
  // start/finish pins around isolation never moves the camera. Optional,
  // defaults false, so every non-finalized caller is unaffected.
  isolatedActive?: boolean;
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
  pickingLodging = false,
  planRouteLines,
  planMarkers,
  activeDaySegments,
  dayBoundaryMarkers,
  lodgingMarkers,
  onSegmentClick,
  highlightedDay,
  selectedStopId,
  onSelectStop,
  selectedLodgingPlaceId,
  onSelectLodging,
  onClosePopup,
  onToggleStop,
  isolatedActive = false,
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
        pickingLodging={pickingLodging}
        planRouteLines={showOverlay ? planRouteLines : []}
        planMarkers={showOverlay ? planMarkers : []}
        activeDaySegments={showOverlay ? activeDaySegments : []}
        dayBoundaryMarkers={showOverlay ? dayBoundaryMarkers : []}
        lodgingMarkers={showOverlay ? lodgingMarkers : []}
        onSegmentClick={onSegmentClick}
        highlightedDay={highlightedDay}
        selectedStopId={selectedStopId}
        onSelectStop={onSelectStop}
        selectedLodgingPlaceId={selectedLodgingPlaceId}
        onSelectLodging={onSelectLodging}
        onClosePopup={onClosePopup}
        onToggleStop={onToggleStop}
        readOnly={phase === 'finalized' || phase === 'finalizing'}
        isolatedActive={isolatedActive}
      />
    </div>
  );
};
