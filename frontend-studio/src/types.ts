export interface QuizQuestion {
  k: string;
  q: string;
  type: 'text' | 'one' | 'many';
  ph?: string;
  def?: string;
  opts?: string[];
}

export interface Stop {
  i: number;
  n: string;
  c: string;
  d: number;
  w: number;
  vis: string;
  why: string;
}

export interface Day {
  n: number;
  t: string;
  drive: string;
  dense: boolean;
  stops: Stop[];
}

export interface Coordinate {
  lat: number;
  lng: number;
}

export interface Overnight {
  n: string;
  lat: number;
  lng: number;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'bot' | 'sys';
  text: string;
}

export interface SavedTrip {
  id: string;
  title: string;
  origin: string;
  dest: string;
  status: "draft" | "ready" | "completed" | "archived";
  answers: Record<string, string | string[]>;
  plan: { days: Day[]; version: number; removedIndices?: number[] } | null;
  createdAt: string;
  updatedAt: string;
}

