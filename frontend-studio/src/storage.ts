import { SavedTrip } from './types';

const STORAGE_KEY = 'roadtrip_trips';

function getRawTrips(): SavedTrip[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch (error) {
    console.error('Failed to read from localStorage:', error);
  }
  return [];
}

function saveRawTrips(trips: SavedTrip[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trips));
  } catch (error) {
    console.error('Failed to write to localStorage:', error);
  }
}

/**
 * Returns all saved trips sorted by updatedAt in descending order.
 */
export function listTrips(): SavedTrip[] {
  const trips = getRawTrips();
  return trips.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}

/**
 * Retrieves a single trip by its ID, or returns null.
 */
export function getTrip(id: string): SavedTrip | null {
  const trips = getRawTrips();
  const trip = trips.find(t => t.id === id);
  return trip || null;
}

/**
 * Saves or updates a trip, setting/updating the updatedAt field to the current ISO string.
 * Ensures createdAt is set if not already present.
 */
export function saveTrip(trip: SavedTrip): SavedTrip {
  const trips = getRawTrips();
  const now = new Date().toISOString();
  
  const updatedTrip: SavedTrip = {
    ...trip,
    updatedAt: now,
    createdAt: trip.createdAt || now
  };

  const index = trips.findIndex(t => t.id === trip.id);
  if (index !== -1) {
    trips[index] = updatedTrip;
  } else {
    trips.push(updatedTrip);
  }

  saveRawTrips(trips);
  return updatedTrip;
}

/**
 * Deletes a trip by its ID.
 */
export function deleteTrip(id: string): void {
  const trips = getRawTrips();
  const filtered = trips.filter(t => t.id !== id);
  saveRawTrips(filtered);
}

/**
 * Marks a trip as archived by setting its status to "archived".
 */
export function archiveTrip(id: string): void {
  const trips = getRawTrips();
  const index = trips.findIndex(t => t.id === id);
  if (index !== -1) {
    trips[index] = {
      ...trips[index],
      status: 'archived',
      updatedAt: new Date().toISOString()
    };
    saveRawTrips(trips);
  }
}
