export interface QuizQuestion {
  k: string;
  q: string;
  // 'days' is a compound stepper (integer count) + a "flexible_days" checkbox,
  // rendered together as one step — not a generic reusable question shape.
  type: 'text' | 'one' | 'many' | 'days';
  ph?: string;
  def?: string | number;
  opts?: string[];
}

export type QuizAnswerValue = string | string[] | number | boolean;

export interface ChatMessage {
  id: string;
  sender: 'user' | 'bot' | 'sys';
  text: string;
}

