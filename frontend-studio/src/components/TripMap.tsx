import React, { useEffect, useRef } from 'react';
import { APIProvider, Map, AdvancedMarker, useMap } from '@vis.gl/react-google-maps';
import { COORDS, OVERNIGHTS } from '../data';

export interface TripMapProps {
  activeStopIndex: number | null;
  onStopClick: (index: number) => void;
  removedIndices: number[];
  drawPath: boolean;
  drawStops: boolean;
  drawOvernights: boolean;
  path: Array<{ lat: number; lng: number }>;
  originCoord: { lat: number; lng: number } | null;
  destCoord: { lat: number; lng: number } | null;
  onOriginDragEnd: (lat: number, lng: number) => void;
  onDestDragEnd: (lat: number, lng: number) => void;
  pickingField: 'origin' | 'dest' | null;
  onMapClick: (lat: number, lng: number) => void;
}

const MAP_STYLES = [
  { elementType: "geometry", stylers: [{ color: "#2c3138" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8b9199" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#22262b" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#3a4048" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#1b2b33" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "administrative", elementType: "geometry", stylers: [{ color: "#4a5058" }] }
];

// Helper component to render the custom Polyline using native google.maps.Polyline
const MapPolyline: React.FC<{ path: Array<{ lat: number; lng: number }>; visible: boolean }> = ({ path, visible }) => {
  const map = useMap();
  const polylineRef = useRef<google.maps.Polyline | null>(null);

  useEffect(() => {
    if (!map || !window.google) return;

    if (polylineRef.current) {
      polylineRef.current.setMap(null);
      polylineRef.current = null;
    }

    if (!visible || !path || path.length === 0) return;

    const polyline = new window.google.maps.Polyline({
      path,
      strokeColor: '#e8b53f',
      strokeOpacity: 0.9,
      strokeWeight: 3,
      map
    });

    polylineRef.current = polyline;

    return () => {
      if (polylineRef.current) {
        polylineRef.current.setMap(null);
      }
    };
  }, [map, path, visible]);

  return null;
};

// Renders a diamond-shaped pin for a route endpoint (origin/destination) — visually
// distinct from the round stop/overnight markers since these aren't POIs. Draggable;
// only reports the drop position on dragend, never during the drag itself.
const EndpointMarker: React.FC<{
  position: { lat: number; lng: number };
  label: string;
  color: string;
  onDragEnd: (lat: number, lng: number) => void;
}> = ({ position, label, color, onDragEnd }) => (
  <AdvancedMarker
    position={position}
    draggable
    onDragEnd={(e) => {
      if (e.latLng) {
        onDragEnd(e.latLng.lat(), e.latLng.lng());
      }
    }}
  >
    <div
      style={{
        width: '22px',
        height: '22px',
        borderRadius: '4px',
        backgroundColor: color,
        border: '2px solid #f2ede3',
        transform: 'rotate(45deg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
        cursor: 'grab',
      }}
    >
      <span style={{ transform: 'rotate(-45deg)', color: '#f2ede3', fontSize: '10px', fontWeight: 700 }}>
        {label}
      </span>
    </div>
  </AdvancedMarker>
);

// Helper component to handle selectedStopIndex pan/zoom/bounce actions
const MapController: React.FC<{
  activeStopIndex: number | null;
  drawPath: boolean;
  path: Array<{ lat: number; lng: number }>;
  originCoord: { lat: number; lng: number } | null;
  destCoord: { lat: number; lng: number } | null;
}> = ({ activeStopIndex, drawPath, path, originCoord, destCoord }) => {
  const map = useMap();

  // Fit/center priority: full route path > both endpoints > single endpoint > default view
  useEffect(() => {
    if (!map || !window.google) return;

    if (drawPath && path.length > 0) {
      const bounds = new window.google.maps.LatLngBounds();
      path.forEach(p => bounds.extend(p));
      map.fitBounds(bounds, 60);
      return;
    }

    if (originCoord && destCoord) {
      const bounds = new window.google.maps.LatLngBounds();
      bounds.extend(originCoord);
      bounds.extend(destCoord);
      map.fitBounds(bounds, 80);
      return;
    }

    if (originCoord) {
      map.panTo(originCoord);
      map.setZoom(9);
      return;
    }

    // Default initial view
    map.setCenter({ lat: 38.6, lng: -108.5 });
    map.setZoom(6);
  }, [map, drawPath, path, originCoord, destCoord]);

  // Center on active stop
  useEffect(() => {
    if (!map || activeStopIndex === null || activeStopIndex === undefined) return;
    const coord = COORDS[activeStopIndex];
    if (coord) {
      map.panTo(coord);
      map.setZoom(9);
    }
  }, [map, activeStopIndex]);

  return null;
};

export const TripMap: React.FC<TripMapProps> = ({
  activeStopIndex,
  onStopClick,
  removedIndices,
  drawPath,
  drawStops,
  drawOvernights,
  path,
  originCoord,
  destCoord,
  onOriginDragEnd,
  onDestDragEnd,
  pickingField,
  onMapClick
}) => {
  const API_KEY = (import.meta as any).env?.VITE_GOOGLE_MAPS_KEY || '';
  const hasValidKey = Boolean(API_KEY) && API_KEY.trim() !== '' && API_KEY !== 'YOUR_API_KEY';

  if (!hasValidKey) {
    return (
      <div className="map-wrap">
        <div id="map" className="flex items-center justify-center bg-[#2c3138]" />
        <div className="map-note" id="note">
          Карта не загружена.<br />
          Вставьте ключ в <code>GOOGLE_MAPS_KEY</code> внизу файла.
        </div>
      </div>
    );
  }

  const defaultCenter = { lat: 38.6, lng: -108.5 };

  return (
    <APIProvider apiKey={API_KEY} version="weekly">
      <div className="relative w-full h-full overflow-hidden">
        <Map
          defaultCenter={defaultCenter}
          defaultZoom={6}
          mapId="TRIP_MAP_ID"
          styles={MAP_STYLES}
          mapTypeControl={false}
          streetViewControl={false}
          fullscreenControl={false}
          draggableCursor={pickingField ? 'crosshair' : undefined}
          onClick={(e) => {
            // Fires on a plain map click; Google Maps does not re-fire this for marker
            // clicks (those are separate marker click events) or for click-free panning/drags.
            // Note: this library's own MapMouseEvent puts coords under `.detail.latLng` as a
            // plain {lat, lng} literal — NOT a top-level `.latLng` with .lat()/.lng() methods
            // like the native google.maps.MapMouseEvent used by AdvancedMarker's onDragEnd.
            console.log('[TripMap] map onClick fired', e);
            if (e.detail.latLng) {
              onMapClick(e.detail.latLng.lat, e.detail.latLng.lng);
            }
          }}
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          className="w-full h-full"
        >
          {/* Main Polyline */}
          <MapPolyline path={path} visible={drawPath} />

          {/* Origin/destination endpoint markers */}
          {originCoord && (
            <EndpointMarker position={originCoord} label="A" color="#4a90d9" onDragEnd={onOriginDragEnd} />
          )}
          {destCoord && (
            <EndpointMarker position={destCoord} label="B" color="#b968c7" onDragEnd={onDestDragEnd} />
          )}

          {/* Markers for stops */}
          {drawStops && COORDS.map((coord, idx) => {
            if (removedIndices.includes(idx)) return null;
            const isSelected = activeStopIndex === idx;

            return (
              <AdvancedMarker
                key={`stop-${idx}`}
                position={coord}
                onClick={() => onStopClick(idx)}
              >
                <div
                  className={`transition-transform duration-300 ${isSelected ? 'scale-125' : 'scale-100'}`}
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    backgroundColor: '#6f8b6e',
                    border: '1.5px solid #f2ede3',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#14171a',
                    fontSize: '11px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                  }}
                >
                  {idx + 1}
                </div>
              </AdvancedMarker>
            );
          })}

          {/* Markers for overnights */}
          {drawOvernights && OVERNIGHTS.map((overnight, idx) => (
            <AdvancedMarker
              key={`overnight-${idx}`}
              position={{ lat: overnight.lat, lng: overnight.lng }}
            >
              <div
                title={overnight.n}
                style={{
                  width: '12px',
                  height: '12px',
                  borderRadius: '50%',
                  backgroundColor: '#c05640',
                  border: '1.5px solid #f2ede3',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                }}
              />
            </AdvancedMarker>
          ))}

          {/* FitBounds & Active stop centering controller */}
          <MapController
            activeStopIndex={activeStopIndex}
            drawPath={drawPath}
            path={path}
            originCoord={originCoord}
            destCoord={destCoord}
          />
        </Map>

        {/* Map picking mode hint */}
        {pickingField && (
          <div
            style={{
              position: 'absolute',
              top: '14px',
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(34, 38, 43, 0.94)',
              border: '1px solid #3a4048',
              borderRadius: '7px',
              padding: '8px 14px',
              fontSize: '13px',
              color: '#f2ede3',
              pointerEvents: 'none',
            }}
          >
            {pickingField === 'origin'
              ? 'Кликните, чтобы поставить точку старта'
              : 'Кликните, чтобы поставить точку финиша'}
          </div>
        )}

        {/* Legend Panel */}
        <div className={`legend ${!drawPath && !drawStops && !originCoord && !destCoord ? 'hidden' : ''}`} id="legend">
          {(originCoord || destCoord) && <div><i style={{ background: '#4a90d9' }}></i>старт / финиш</div>}
          <div><i style={{ background: '#e8b53f' }}></i>маршрут</div>
          <div><i style={{ background: '#6f8b6e' }}></i>остановка</div>
          <div><i style={{ background: '#c05640' }}></i>ночёвка</div>
        </div>
      </div>
    </APIProvider>
  );
};
