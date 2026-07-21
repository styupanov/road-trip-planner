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

// Single z-order hierarchy for every AdvancedMarker layer on this map (higher
// = drawn on top). Without an explicit zIndex, Google Maps falls back to its
// own collision heuristics — not deterministic between renders, which is
// exactly why overlapping stop/endpoint markers used to flip which one sat
// on top from one render to the next. Named constants, not magic numbers at
// each call site, so the ordering lives in ONE place; steps of 10 leave room
// for a future modifier within a layer without renumbering everything else.
// Polylines (google.maps.Polyline) are a completely separate rendering
// system and never participate in this — see MapPolyline, untouched.
const Z_STOP_UNSELECTED = 10;
const Z_STOP_SELECTED = 20;
const Z_DAY_BADGE = 30;
const Z_ENDPOINT = 40;
const Z_LODGING_UNSELECTED = 50;
const Z_LODGING_SELECTED = 60;

export interface PlanMapMarker {
  stop: ApiStop;
  included: boolean;
  // 1-based position among included stops, in route order; null when excluded
  order: number | null;
}

export interface LodgingMapMarker {
  position: { lat: number; lng: number };
  name: string;
  placeId: string;
  rating: number | null;
  userRatingsTotal: number | null;
  priceLevel: number | null;
  vicinity: string | null;
  mapsUrl: string;
  // true for the night's chosen lodging — rendered bright/on-top; false for
  // an unpicked candidate (see finalize.py's lodging_options) — rendered
  // muted/underneath. Old snapshots without lodging_options only ever
  // produce selected:true markers (App.tsx falls back to the single
  // `lodging` field), so this degrades cleanly.
  selected: boolean;
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
  // dayNumber is the 1-based day.day this leg belongs to (matches FinalizedView's
  // day numbering) — only meaningfully clickable in phase 'finalized', see
  // onSegmentClick, but always present so the type is uniform across phases.
  activeDaySegments: Array<{ points: Array<{ lat: number; lng: number }>; color: string; dayNumber: number }>;
  // Small colored badges at each point where the route's day color changes.
  dayBoundaryMarkers: Array<{ position: { lat: number; lng: number }; color: string; label: string }>;
  // Клик по сегменту карты -> панель (Фаза "сворачиваемые дни"): reports
  // which day's segment was clicked, regardless of which of its (possibly
  // several) leg-polylines the user actually clicked — every leg belonging
  // to the same day already carries that day's number.
  onSegmentClick?: (dayNumber: number) => void;
  // Optional reverse highlight (panel hover -> map): the segments whose
  // dayNumber matches render thicker. Never required — omitted, no segment
  // is treated as highlighted.
  highlightedDay?: number | null;
  // Фаза ночёвок: one marker per lodging option shown for a night (selected
  // AND unpicked candidates) — only ever non-empty in phase 'finalized' (a
  // snapshot's lodging data), never in 'plan' (nothing is chosen yet during
  // the free draft).
  lodgingMarkers: LodgingMapMarker[];
  selectedStopId: number | null;
  onSelectStop: (id: number) => void;
  selectedLodgingPlaceId: string | null;
  onSelectLodging: (placeId: string) => void;
  // Closes whatever popup is open — plain map click or a different marker click.
  onClosePopup: () => void;
  onToggleStop: (id: number) => void;
  // Finalized-trip view (Фаза 3, подшаг 3): immutable, no edits possible.
  // Hides the stop popup's include/exclude checkbox and stops the A/B
  // endpoint markers from being draggable — everything else (route lines,
  // day segments, stop selection for panning) renders exactly the same as
  // 'plan'. Defaults false so every existing 'plan'-phase caller is unchanged.
  readOnly?: boolean;
  // Day isolation (finalized map): true while a single day is isolated —
  // see MapController's own comment for why this suppresses autofit.
  // Defaults false so every existing caller (nothing isolated) is unaffected.
  isolatedActive?: boolean;
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
  onClick?: () => void;
}> = ({ path, visible, color = '#e8b53f', opacity = 0.9, weight = 3, onClick }) => {
  const map = useMap();
  const polylineRef = useRef<google.maps.Polyline | null>(null);
  // Ref, not a dependency: onClick is a fresh inline closure on every App.tsx
  // render (it captures the segment's dayNumber) — routing it through a ref
  // (same pattern as GoogleSignInButton's onCredentialRef) means the
  // google.maps.Polyline instance below is only destroyed/recreated when
  // path/color/weight actually change, never just because the callback's
  // identity did.
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

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
    const listener = polyline.addListener('click', () => onClickRef.current?.());

    return () => {
      listener.remove();
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
  readOnly?: boolean;
}> = ({ position, label, color, onDragEnd, readOnly }) => (
  <AdvancedMarker
    position={position}
    draggable={!readOnly}
    zIndex={Z_ENDPOINT}
    onDragEnd={(e) => {
      if (!readOnly && e.latLng) {
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
        cursor: readOnly ? 'default' : 'grab',
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
  readOnly?: boolean;
}> = ({ marker, onToggleStop, onClose, readOnly }) => {
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
          {!readOnly && (
            <input
              type="checkbox"
              checked={included}
              onChange={() => onToggleStop(stop.id)}
              style={{ cursor: 'pointer' }}
            />
          )}
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

// Popup shown for a lodging marker (selected or a candidate) — mirrors
// StopPopup's layout/typography, no checkbox (lodging on a finalized trip
// is never editable), plus a maps_url link like the day export buttons use.
const LodgingPopup: React.FC<{
  marker: LodgingMapMarker;
  onClose: () => void;
}> = ({ marker, onClose }) => (
  <InfoWindow position={marker.position} onCloseClick={onClose}>
    <div style={{ color: '#14171a', minWidth: '200px', maxWidth: '240px' }}>
      <div style={{ fontSize: '10px', textTransform: 'uppercase', color: '#6c727a', marginBottom: '4px' }}>
        {marker.selected ? 'Выбранная ночёвка' : 'Вариант ночёвки'}
      </div>
      <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '4px' }}>{marker.name}</div>
      <div style={{ fontSize: '12px', color: '#6c727a', marginBottom: '2px' }}>
        {marker.rating != null ? `★ ${marker.rating.toFixed(1)}` : 'без рейтинга'}
        {marker.userRatingsTotal != null ? ` · ${marker.userRatingsTotal} отзывов` : ''}
      </div>
      {marker.priceLevel != null && (
        <div style={{ fontSize: '12px', color: '#6c727a', marginBottom: '2px' }}>
          {'$'.repeat(Math.max(1, marker.priceLevel))}
        </div>
      )}
      {marker.vicinity && (
        <div style={{ fontSize: '11px', color: '#6c727a', marginBottom: '4px' }}>{marker.vicinity}</div>
      )}
      <a
        href={marker.mapsUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ fontSize: '11px', color: '#c05640', fontWeight: 600 }}
      >
        Открыть в Google Maps
      </a>
    </div>
  </InfoWindow>
);

// Helper component to handle map fit/pan/zoom actions
const MapController: React.FC<{
  drawPath: boolean;
  path: Array<{ lat: number; lng: number }>;
  originCoord: { lat: number; lng: number } | null;
  destCoord: { lat: number; lng: number } | null;
  planMarkers: PlanMapMarker[];
  selectedStopId: number | null;
  // Day isolation (finalized map): App.tsx nulls originCoord/destCoord to
  // hide the start/finish pins while a single day is isolated, which would
  // otherwise change this effect's own dependencies and trigger an
  // unwanted autofit — the user explicitly stayed where they were zoomed,
  // isolating a day is a visibility filter, not a "recenter" action.
  isolatedActive: boolean;
}> = ({ drawPath, path, originCoord, destCoord, planMarkers, selectedStopId, isolatedActive }) => {
  const map = useMap();
  // True for one extra effect run right after isolatedActive flips back to
  // false — that's the render where origin/destCoord jump back to their
  // real values (isolation just released them), which must NOT autofit
  // either: the user is exiting isolation, not asking to recenter.
  const wasIsolatedRef = useRef(false);

  // Fit/center priority: full route path > both endpoints > single endpoint > default view
  useEffect(() => {
    if (!map || !window.google) return;

    if (isolatedActive) {
      wasIsolatedRef.current = true;
      return; // isolating a day is a visibility filter, never a camera move
    }
    if (wasIsolatedRef.current) {
      wasIsolatedRef.current = false;
      return; // just exited isolation -- origin/destCoord just got restored, don't refit on that either
    }

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
  }, [map, drawPath, path, originCoord, destCoord, isolatedActive]);

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
  lodgingMarkers,
  onSegmentClick,
  highlightedDay,
  selectedStopId,
  onSelectStop,
  selectedLodgingPlaceId,
  onSelectLodging,
  onClosePopup,
  onToggleStop,
  readOnly = false,
  isolatedActive = false,
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
              line always had (9px when this segment's day is highlighted from the
              panel, see highlightedDay), one color per day (see dayColors.ts).
              Clickable when onSegmentClick is given (phase 'finalized') — every
              leg of a multi-leg day reports the SAME dayNumber, so it doesn't
              matter which of a day's segments gets clicked. */}
          {activeDaySegments.map((segment, idx) => (
            <MapPolyline
              key={`day-segment-${idx}`}
              path={segment.points}
              visible={true}
              color={segment.color}
              opacity={1.0}
              weight={segment.dayNumber === highlightedDay ? 9 : 6}
              onClick={onSegmentClick ? () => onSegmentClick(segment.dayNumber) : undefined}
            />
          ))}

          {/* Origin/destination endpoint markers */}
          {originCoord && (
            <EndpointMarker position={originCoord} label="A" color="#4a90d9" onDragEnd={onOriginDragEnd} readOnly={readOnly} />
          )}
          {destCoord && (
            <EndpointMarker position={destCoord} label="B" color="#b968c7" onDragEnd={onDestDragEnd} readOnly={readOnly} />
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
                zIndex={included ? Z_STOP_SELECTED : Z_STOP_UNSELECTED}
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
              zIndex={Z_DAY_BADGE}
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

          {/* Lodging markers (Фаза ночёвок): a distinct bed icon + color, never
              confused with a yellow stop marker or a day-boundary badge.
              Selected sits ABOVE unpicked candidates (higher zIndex) and
              renders bright; unpicked candidates render muted — same
              selected/excluded z-order convention as stop markers. */}
          {lodgingMarkers.map((marker, idx) => (
            <AdvancedMarker
              key={`lodging-${idx}`}
              position={marker.position}
              title={marker.name}
              zIndex={marker.selected ? Z_LODGING_SELECTED : Z_LODGING_UNSELECTED}
              onClick={() => onSelectLodging(marker.placeId)}
            >
              <div
                style={{
                  width: '24px',
                  height: '24px',
                  borderRadius: '6px',
                  backgroundColor: marker.selected ? '#16a085' : '#5a5f66',
                  border: '2px solid #14171a',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                  lineHeight: 1,
                  opacity: marker.selected ? 1 : 0.55,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                  cursor: 'pointer',
                }}
              >
                🛏
              </div>
            </AdvancedMarker>
          ))}

          {/* Popup for the selected stop — only one open at a time, closed by a plain
              map click or by selecting a different marker (both just change/clear
              selectedStopId, which this is keyed off of). */}
          {selectedStopId !== null && (() => {
            const marker = planMarkers.find(m => m.stop.id === selectedStopId);
            if (!marker) return null;
            return <StopPopup marker={marker} onToggleStop={onToggleStop} onClose={onClosePopup} readOnly={readOnly} />;
          })()}

          {/* Popup for the selected lodging marker — same "one open at a
              time" mechanism as StopPopup, keyed off selectedLodgingPlaceId
              instead. Selecting a stop or a lodging marker clears the other
              (see App.tsx's handleSelectStop/handleSelectLodging), so the
              two popups can never both be open. */}
          {selectedLodgingPlaceId !== null && (() => {
            const marker = lodgingMarkers.find(m => m.placeId === selectedLodgingPlaceId);
            if (!marker) return null;
            return <LodgingPopup marker={marker} onClose={onClosePopup} />;
          })()}

          {/* FitBounds & selected-stop centering controller */}
          <MapController
            drawPath={drawPath}
            path={path}
            originCoord={originCoord}
            destCoord={destCoord}
            planMarkers={planMarkers}
            selectedStopId={selectedStopId}
            isolatedActive={isolatedActive}
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
          {lodgingMarkers.some(m => m.selected) && (
            <div><i style={{ background: '#16a085' }}></i>ночёвка (выбрана)</div>
          )}
          {lodgingMarkers.some(m => !m.selected) && (
            <div><i style={{ background: '#5a5f66', opacity: 0.55 }}></i>вариант ночёвки</div>
          )}
        </div>
      </div>
    </APIProvider>
  );
};
