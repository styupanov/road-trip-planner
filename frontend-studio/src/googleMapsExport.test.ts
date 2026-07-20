// Not wired into a test runner — this project has none configured (see
// CLAUDE.md). Uses Node's built-in assert instead of adding a new
// dependency just for one file. Run directly: npx tsx src/googleMapsExport.test.ts
import assert from 'node:assert/strict';
import { FinalizedDay, FinalizedLodging, FinalizedStop } from './api';
import { buildGoogleMapsDayUrl } from './googleMapsExport';

const stop = (id: number, lat: number, lon: number): FinalizedStop => ({
  id, name: `Stop ${id}`, category: 'Nature & Parks', rating: null, review_count: null,
  lat, lon, detour_s: 0, why: '', tips: null, dates_note: null, leg: null,
});

const lodging = (placeId: string, lat: number, lon: number): FinalizedLodging => ({
  place_id: placeId, name: 'Hotel', lat, lon, maps_url: '', rating: null, vicinity: null,
});

const day = (n: number, stopIndices: number[], lodging: FinalizedLodging | null): FinalizedDay => ({
  day: n, stop_indices: stopIndices, drive_s: 0, visit_s: 0, total_s: 0, over_limit: false, lodging,
});

const tripStart = { lat: 39.7392, lon: -104.9903 };

let passed = 0;
function check(label: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`PASS: ${label}`);
}

check('day 1, no lodging: origin=tripStart, last stop promoted to destination', () => {
  const stops = [stop(1, 38.0, -107.6), stop(2, 38.1, -107.7)];
  const url = buildGoogleMapsDayUrl(day(1, [0, 1], null), stops, null, tripStart);
  assert.ok(url);
  const p = new URL(url!).searchParams;
  assert.equal(p.get('api'), '1');
  assert.equal(p.get('origin'), '39.7392,-104.9903');
  assert.equal(p.get('destination'), '38.1,-107.7');
  assert.equal(p.get('waypoints'), '38,-107.6');
  assert.equal(p.get('travelmode'), 'driving');
  assert.equal(p.has('origin_place_id'), false);
});

check('day N with lodging at both ends: origin=prev lodging, destination=this lodging', () => {
  const stops = [stop(3, 38.2, -107.8)];
  const prevLodging = lodging('ChIJprev', 38.15, -107.75);
  const url = buildGoogleMapsDayUrl(day(2, [0], lodging('ChIJcur', 38.25, -107.85)), stops, prevLodging, tripStart);
  assert.ok(url);
  const p = new URL(url!).searchParams;
  assert.equal(p.get('origin'), '38.15,-107.75');
  assert.equal(p.get('destination'), '38.25,-107.85');
  assert.equal(p.get('waypoints'), '38.2,-107.8');
});

check('skipped previous lodging: origin = first stop of today, removed from waypoints', () => {
  const stops = [stop(4, 38.3, -107.9), stop(5, 38.4, -108.0)];
  const url = buildGoogleMapsDayUrl(day(3, [0, 1], null), stops, null, tripStart);
  assert.ok(url);
  const p = new URL(url!).searchParams;
  assert.equal(p.get('origin'), '38.3,-107.9');
  assert.equal(p.get('destination'), '38.4,-108');
  assert.equal(p.has('waypoints'), false); // both stops consumed by origin/destination
});

check('>8 waypoints truncated to the first 8 in route order', () => {
  // Both ends supplied by lodging so all 10 stops stay candidate waypoints —
  // isolates the truncation behavior from the origin/destination-consumes-
  // a-stop rules already covered above.
  const stops = Array.from({ length: 10 }, (_, i) => stop(i + 10, 38 + i * 0.01, -107 - i * 0.01));
  const prevLodging = lodging('ChIJprev', 37.9, -106.9);
  const url = buildGoogleMapsDayUrl(day(4, stops.map((_, i) => i), lodging('ChIJtoday', 39, -108)), stops, prevLodging, tripStart);
  assert.ok(url);
  const wps = new URL(url!).searchParams.get('waypoints')!.split('|');
  assert.equal(wps.length, 8);
  assert.equal(wps[0], '38,-107'); // first in route order kept
  assert.equal(wps[7], `${(38 + 7 * 0.01).toString()},${(-107 - 7 * 0.01).toString()}`);
});

check('place_id present on every point of the link -> place_id params included', () => {
  // Synthetic on purpose: real FinalizedStops never carry a Google
  // place_id (see poi.py — the local attractions DB, not Places), so this
  // only exercises the logic using lodging-only points (no stops between).
  const prevLodging = lodging('ChIJorigin', 38.1, -107.1);
  const curLodging = lodging('ChIJdest', 38.2, -107.2);
  const url = buildGoogleMapsDayUrl(day(2, [], curLodging), [], prevLodging, tripStart);
  assert.ok(url);
  const p = new URL(url!).searchParams;
  assert.equal(p.get('origin_place_id'), 'ChIJorigin');
  assert.equal(p.get('destination_place_id'), 'ChIJdest');
  assert.equal(p.has('waypoint_place_ids'), false); // no waypoints at all this time
});

check('mixed place_id coverage (a stop has none) omits ALL place_id params', () => {
  const stops = [stop(20, 38.5, -107.5)];
  const prevLodging = lodging('ChIJorigin2', 38.4, -107.4);
  const curLodging = lodging('ChIJdest2', 38.6, -107.6);
  const url = buildGoogleMapsDayUrl(day(2, [0], curLodging), stops, prevLodging, tripStart);
  assert.ok(url);
  const p = new URL(url!).searchParams;
  assert.equal(p.has('origin_place_id'), false);
  assert.equal(p.has('destination_place_id'), false);
  assert.equal(p.has('waypoint_place_ids'), false);
});

check('degenerate day (no stops, no lodging, not day 1) -> null, no button', () => {
  const url = buildGoogleMapsDayUrl(day(3, [], null), [], null, tripStart);
  assert.equal(url, null);
});

check('single stop consumed as origin leaves nothing for destination -> null', () => {
  const stops = [stop(30, 38.0, -107.0)];
  const url = buildGoogleMapsDayUrl(day(2, [0], null), stops, null, tripStart);
  assert.equal(url, null);
});

console.log(`\nAll ${passed} googleMapsExport tests passed.`);
