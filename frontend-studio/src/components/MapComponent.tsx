import React from 'react';
import { TripMap } from './TripMap';

interface MapComponentProps {
  activeStopIndex: number | null;
  onStopClick: (index: number) => void;
  removedIndices: number[];
  phase: 'quiz' | 'refine' | 'gen' | 'ready';
  generationStep: number;
  routeLine: Array<{ lat: number; lng: number }>;
  originCoord: { lat: number; lng: number } | null;
  destCoord: { lat: number; lng: number } | null;
  onOriginDragEnd: (lat: number, lng: number) => void;
  onDestDragEnd: (lat: number, lng: number) => void;
  pickingField: 'origin' | 'dest' | null;
  onMapClick: (lat: number, lng: number) => void;
}

export const MapComponent: React.FC<MapComponentProps> = ({
  activeStopIndex,
  onStopClick,
  removedIndices,
  phase,
  generationStep,
  routeLine,
  originCoord,
  destCoord,
  onOriginDragEnd,
  onDestDragEnd,
  pickingField,
  onMapClick
}) => {
  // Determine what map elements to draw based on current phase and step
  const drawPath = phase === 'ready' || (phase === 'gen' && generationStep >= 0);
  const drawStops = phase === 'ready' || (phase === 'gen' && generationStep >= 2);
  const drawOvernights = phase === 'ready';

  return (
    <div className="relative w-full h-full">
      <TripMap
        activeStopIndex={activeStopIndex}
        onStopClick={onStopClick}
        removedIndices={removedIndices}
        drawPath={drawPath}
        drawStops={drawStops}
        drawOvernights={drawOvernights}
        path={routeLine}
        originCoord={originCoord}
        destCoord={destCoord}
        onOriginDragEnd={onOriginDragEnd}
        onDestDragEnd={onDestDragEnd}
        pickingField={pickingField}
        onMapClick={onMapClick}
      />
    </div>
  );
};
