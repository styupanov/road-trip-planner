import React, { useEffect, useRef, useState } from 'react';
import { APIProvider, Map, AdvancedMarker, InfoWindow, useMap } from '@vis.gl/react-google-maps';
import { ApiStop } from '../api';
import { formatDetour } from '../format';
import { dayColor } from '../dayColors';

// Below this zoom, stop markers render as a bare circle — no name label. An
// AdvancedMarker anchors at the bottom-center of its ENTIRE content box; once a
// label is appended next to the circle, that box widens and the anchor point
// shifts away from the circle's true center by a roughly constant number of
// screen pixels. At low zoom, those few pixels cover a lot of real-world
// distance, so the marker visually detaches from the route/building it should
// sit on (confirmed: a marker can appear off a museum's building at zoom 7-8,
// snapping back onto it once zoomed in) — reads as a data bug though the
// coordinate was always correct. 9 is roughly "one or two Colorado towns fit on
// screen": labels only appear once markers have enough screen space apart that
// this offset stops being visually significant.
const STOP_LABEL_MIN_ZOOM = 9;

export interface PlanMapMarker {
  stop: ApiStop;
  included: boolean;
  // 1-based position among included stops, in route order; null when excluded
  order: number | null;
}

export interface TripMapProps {
  drawPath: boolean;
  path: Array<{ lat: number; lng: number }>;
  originCoord: { lat: number; lng: number } | null;
  destCoord: { lat: number; lng: number } | null;
  onOriginDragEnd: (lat: number, lng: number) => void;
  onDestDragEnd: (lat: number, lng: number) => void;
  pickingField: 'origin' | 'dest' | null;
  onMapClick: (lat: number, lng: number) => void;
  // Phase 'plan' route overlay: every option's base line at once, the active
  // option's line accented (and swapped for its live through-route by the caller).
  planRouteLines: Array<{ points: Array<{ lat: number; lng: number }>; isActive: boolean }>;
  // Phase 'plan' stop markers: only the active option's stops.
  planMarkers: PlanMapMarker[];
  // Replaces planRouteLines' active entry with per-day colored segments, once
  // day_split has run for the active option — empty before that (single-color
  // active line renders as usual). Non-active options are never colored by day.
  activeDaySegments: Array<{ points: Array<{ lat: number; lng: number }>; color: string }>;
  // Small colored badges at each point where the route's day color changes.
  dayBoundaryMarkers: Array<{ position: { lat: number; lng: number }; color: string; label: string }>;
  selectedStopId: number | null;
  onSelectStop: (id: number) => void;
  // Closes whatever popup is open — plain map click or a different marker click.
  onClosePopup: () => void;
  onToggleStop: (id: number) => void;
}

// Route-line color — a rich, saturated blue distinct from the endpoint-marker
// blue (#4a90d9) and from the interface's #e8b53f yellow accent, which is now
// reserved exclusively for stop markers (see legend below). Chosen to read
// clearly against this map's dark custom style (geometry #2c3138, bg #22262b).
const ROUTE_COLOR = '#2f7dee';

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
const MapPolyline: React.FC<{
  path: Array<{ lat: number; lng: number }>;
  visible: boolean;
  color?: string;
  opacity?: number;
  weight?: number;
}> = ({ path, visible, color = '#e8b53f', opacity = 0.9, weight = 3 }) => {
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
      strokeColor: color,
      strokeOpacity: opacity,
      strokeWeight: weight,
      map
    });

    polylineRef.current = polyline;

    return () => {
      if (polylineRef.current) {
        polylineRef.current.setMap(null);
      }
    };
  }, [map, path, visible, color, opacity, weight]);

  return null;
};

// Renders a diamond-shaped pin for a route endpoint (origin/destination) — visually
// distinct from the round stop markers since these aren't POIs. Draggable; only
// reports the drop position on dragend, never during the drag itself.
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

// Popup shown for the selected stop marker. Content mirrors the sidebar card
// (name/category/rating/detour) plus the fields only the map has room for
// (duration, about excerpt, website link) and the same include/exclude checkbox
// as the sidebar list, wired to the same handler.
const StopPopup: React.FC<{
  marker: PlanMapMarker;
  onToggleStop: (id: number) => void;
  onClose: () => void;
}> = ({ marker, onToggleStop, onClose }) => {
  const { stop, included, order } = marker;
  const ABOUT_PREVIEW_LEN = 200;
  const aboutPreview = stop.about
    ? stop.about.length > ABOUT_PREVIEW_LEN
      ? `${stop.about.slice(0, ABOUT_PREVIEW_LEN).trimEnd()}…`
      : stop.about
    : null;

  return (
    <InfoWindow position={{ lat: stop.lat, lng: stop.lon }} onCloseClick={onClose}>
      <div style={{ color: '#14171a', minWidth: '200px', maxWidth: '240px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
          <input
            type="checkbox"
            checked={included}
            onChange={() => onToggleStop(stop.id)}
            style={{ cursor: 'pointer' }}
          />
          {included && order !== null && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '16px',
                height: '16px',
                borderRadius: '50%',
                backgroundColor: '#e8b53f',
                color: '#14171a',
                fontSize: '10px',
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {order}
            </span>
          )}
          <span style={{ fontSize: '10px', textTransform: 'uppercase', color: '#6c727a' }}>
            {stop.category}
          </span>
        </div>

        <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>{stop.name}</div>

        <div style={{ fontSize: '12px', color: '#6c727a', marginBottom: '2px' }}>
          {stop.rating != null ? `★ ${stop.rating.toFixed(1)}` : 'без рейтинга'}
          {stop.review_count != null ? ` · ${stop.review_count} отзывов` : ''}
        </div>

        <div style={{ fontSize: '12px', color: '#6c727a', marginBottom: '2px' }}>
          {formatDetour(stop.detour_s)}
        </div>

        {stop.duration && (
          <div style={{ fontSize: '11px', color: '#6c727a', marginBottom: '4px' }}>
            Обычно занимают: {stop.duration}
          </div>
        )}

        {aboutPreview && (
          <p style={{ fontSize: '11px', color: '#3d434a', lineHeight: 1.4, marginTop: '4px', marginBottom: '4px' }}>
            {aboutPreview}
          </p>
        )}

        {stop.website && (
          <a
            href={stop.website}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: '11px', color: '#c05640', fontWeight: 600 }}
          >
            Сайт
          </a>
        )}
      </div>
    </InfoWindow>
  );
};

// Helper component to handle map fit/pan/zoom actions
const MapController: React.FC<{
  drawPath: boolean;
  path: Array<{ lat: number; lng: number }>;
  originCoord: { lat: number; lng: number } | null;
  destCoord: { lat: number; lng: number } | null;
  planMarkers: PlanMapMarker[];
  selectedStopId: number | null;
}> = ({ drawPath, path, originCoord, destCoord, planMarkers, selectedStopId }) => {
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

  // Center on selected real POI stop
  useEffect(() => {
    if (!map || selectedStopId === null) return;
    const marker = planMarkers.find(m => m.stop.id === selectedStopId);
    if (marker) {
      map.panTo({ lat: marker.stop.lat, lng: marker.stop.lon });
      map.setZoom(11);
    }
  }, [map, selectedStopId, planMarkers]);

  return null;
};

export const TripMap: React.FC<TripMapProps> = ({
  drawPath,
  path,
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
  // Tracks the map's current zoom so stop-marker labels can be hidden below
  // STOP_LABEL_MIN_ZOOM (see comment above) — must be declared before the
  // hasValidKey early return below to satisfy the Rules of Hooks.
  const [zoom, setZoom] = useState<number>(6);

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
  const hasPlanContent = planRouteLines.length > 0 || planMarkers.length > 0;

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
          onZoomChanged={(e) => setZoom(e.detail.zoom)}
          onClick={(e) => {
            // Fires on a plain map click; Google Maps does not re-fire this for marker
            // clicks (those are separate marker click events) or for click-free panning/drags.
            // Note: this library's own MapMouseEvent puts coords under `.detail.latLng` as a
            // plain {lat, lng} literal — NOT a top-level `.latLng` with .lat()/.lng() methods
            // like the native google.maps.MapMouseEvent used by AdvancedMarker's onDragEnd.
            onClosePopup();
            if (e.detail.latLng) {
              onMapClick(e.detail.latLng.lat, e.detail.latLng.lng);
            }
          }}
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          className="w-full h-full"
        >
          {/* Main Polyline — used during 'generating', before the plan overlay exists.
              Same ROUTE_COLOR as the plan overlay so there's no color flash on transition. */}
          <MapPolyline path={path} visible={drawPath} color={ROUTE_COLOR} weight={4} />

          {/* Plan-phase route overlay: every option's base line at once, same blue
              throughout — active is thick and fully opaque, the rest thin and faint,
              so the difference reads as "current vs alternative", not two categories.
              Once activeDaySegments exists (post-detail), it replaces the active
              entry here — alternates are never colored by day. */}
          {planRouteLines.map((route, idx) => {
            if (route.isActive && activeDaySegments.length > 0) return null;
            return (
              <MapPolyline
                key={`plan-route-${idx}`}
                path={route.points}
                visible={true}
                color={ROUTE_COLOR}
                opacity={route.isActive ? 1.0 : 0.35}
                weight={route.isActive ? 6 : 4}
              />
            );
          })}

          {/* Day-colored segments of the active route — same 6px weight the active
              line always had, one color per day (see dayColors.ts). */}
          {activeDaySegments.map((segment, idx) => (
            <MapPolyline
              key={`day-segment-${idx}`}
              path={segment.points}
              visible={true}
              color={segment.color}
              opacity={1.0}
              weight={6}
            />
          ))}

          {/* Origin/destination endpoint markers */}
          {originCoord && (
            <EndpointMarker position={originCoord} label="A" color="#4a90d9" onDragEnd={onOriginDragEnd} />
          )}
          {destCoord && (
            <EndpointMarker position={destCoord} label="B" color="#b968c7" onDragEnd={onDestDragEnd} />
          )}

          {/* Plan-phase stop markers: accent + order number when included, muted when not.
              Name label rides alongside the marker only for included stops — labeling
              every candidate would bury the map once a corridor has 20+ nearby POIs.
              Below STOP_LABEL_MIN_ZOOM the label is dropped entirely (see comment at
              top of file) EXCEPT for the selected stop — the user explicitly pointed
              at it (popup open), so its label stays regardless of zoom. */}
          {planMarkers.map(({ stop, included, order }) => {
            const isSelected = selectedStopId === stop.id;
            const showLabel = included && (isSelected || zoom >= STOP_LABEL_MIN_ZOOM);

            return (
              <AdvancedMarker
                key={`plan-stop-${stop.id}`}
                position={{ lat: stop.lat, lng: stop.lon }}
                onClick={() => onSelectStop(stop.id)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <div
                    className={`transition-transform duration-300 ${isSelected ? 'scale-125' : 'scale-100'}`}
                    style={{
                      width: '22px',
                      height: '22px',
                      borderRadius: '50%',
                      backgroundColor: included ? '#e8b53f' : '#5a5f66',
                      border: `1.5px solid ${included ? '#22262b' : '#8b9199'}`,
                      opacity: included ? 1 : 0.6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: included ? '#22262b' : '#c8ccd1',
                      fontSize: '11px',
                      fontWeight: '700',
                      cursor: 'pointer',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
                      flexShrink: 0,
                    }}
                  >
                    {included ? order : '★'}
                  </div>
                  {showLabel && (
                    <span
                      style={{
                        fontSize: '11px',
                        fontWeight: 600,
                        color: '#f2ede3',
                        background: 'rgba(20, 23, 26, 0.85)',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        whiteSpace: 'nowrap',
                        boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
                        pointerEvents: 'none',
                      }}
                    >
                      {stop.name}
                    </span>
                  )}
                </div>
              </AdvancedMarker>
            );
          })}

          {/* Day-boundary badges: only where the route's day color changes, not on
              every stop — a small circle in the day it's ENTERING plus its number. */}
          {dayBoundaryMarkers.map((marker, idx) => (
            <AdvancedMarker
              key={`day-boundary-${idx}`}
              position={marker.position}
              zIndex={5}
            >
              <div
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: '50%',
                  backgroundColor: marker.color,
                  border: '1.5px solid #14171a',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#f2ede3',
                  fontSize: '9px',
                  fontWeight: 700,
                  boxShadow: '0 1px 2px rgba(0,0,0,0.5)',
                  pointerEvents: 'none',
                }}
              >
                {marker.label}
              </div>
            </AdvancedMarker>
          ))}

          {/* Popup for the selected stop — only one open at a time, closed by a plain
              map click or by selecting a different marker (both just change/clear
              selectedStopId, which this is keyed off of). */}
          {selectedStopId !== null && (() => {
            const marker = planMarkers.find(m => m.stop.id === selectedStopId);
            if (!marker) return null;
            return <StopPopup marker={marker} onToggleStop={onToggleStop} onClose={onClosePopup} />;
          })()}

          {/* FitBounds & selected-stop centering controller */}
          <MapController
            drawPath={drawPath}
            path={path}
            originCoord={originCoord}
            destCoord={destCoord}
            planMarkers={planMarkers}
            selectedStopId={selectedStopId}
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

        {/* Legend Panel — #e8b53f is now exclusively the stop-marker color; both
            route swatches share the same blue, distinguished only by the same
            opacity difference actually used on the map (1.0 vs 0.35). Once the
            active route is day-colored, its single swatch is replaced by one
            per day (same dayColor() the map segments and PlanPanel headers use). */}
        <div className={`legend ${!drawPath && !hasPlanContent && !originCoord && !destCoord ? 'hidden' : ''}`} id="legend">
          {(originCoord || destCoord) && <div><i style={{ background: '#4a90d9' }}></i>старт / финиш</div>}
          {activeDaySegments.length > 0 ? (
            Array.from({ length: dayBoundaryMarkers.length + 1 }, (_, i) => (
              <div key={`day-legend-${i}`}><i style={{ background: dayColor(i) }}></i>день {i + 1}</div>
            ))
          ) : (
            <div><i style={{ background: ROUTE_COLOR }}></i>маршрут (активный)</div>
          )}
          {planRouteLines.length > 1 && (
            <div><i style={{ background: ROUTE_COLOR, opacity: 0.35 }}></i>другие варианты</div>
          )}
          <div><i style={{ background: '#e8b53f' }}></i>остановка</div>
        </div>
      </div>
    </APIProvider>
  );
};
