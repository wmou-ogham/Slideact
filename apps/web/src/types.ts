export type Profile = {
  id: string;
  display_name: string;
  locale: string;
  email: string | null;
  account_type: "google" | "guest";
  vault_id: string | null;
};

export type GuestVaultFile = {
  kind: "slideact.guest_vault";
  version: 1;
  vault_id: string;
  recovery_key: string;
};

export type Project = {
  id: string;
  title: string;
  status: string;
  default_locale: string;
};

export type InteractionOption = {
  id: string;
  position: number;
  label: string;
  is_correct: boolean | null;
};

export type Interaction = {
  id: string;
  cue_id: string;
  position: number;
  interaction_type: "understanding" | "single_choice" | "word_cloud" | "qa";
  prompt: string;
  description: string | null;
  settings: Record<string, unknown>;
  options: InteractionOption[];
};

export type Cue = {
  id: string;
  project_id: string;
  position: number;
  name: string;
  anchor_type: "manual" | "deck_slide";
  anchor_value: string | null;
  trigger_mode: "immediate" | "presenter_confirm" | "delay";
  delay_seconds: number;
  interactions: Interaction[];
};

export type LiveSession = {
  id: string;
  project_id: string;
  join_code: string | null;
  status: "draft" | "lobby" | "live" | "paused" | "ended";
  locale: string;
  sync_mode: string;
  state_version: number;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
};

export type SessionResults = {
  session_id: string;
  status: LiveSession["status"];
  join_code: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  audience_count: number;
  cue_runs: Array<{
    id: string;
    cue_id: string;
    cue_name: string;
    anchor_value: string | null;
    run_number: number;
    state: string;
    created_at: string;
    opened_at: string | null;
    closed_at: string | null;
    revealed_at: string | null;
    interactions: Array<{
      id: string;
      interaction_type: string;
      prompt: string;
      aggregate: Aggregate | null;
    }>;
    questions: Array<{
      id: string;
      body: string;
      status: string;
      votes: number;
      created_at: string;
    }>;
  }>;
};

export type SnapshotInteraction = Omit<Interaction, "cue_id" | "position">;

export type SessionSnapshot = {
  session_id: string;
  project_id: string;
  join_code: string | null;
  status: LiveSession["status"];
  locale: string;
  sync_mode: string;
  state_version: number;
  presentation_view: "join_qr" | "cue";
  current_cue_run: null | {
    id: string;
    cue_id: string;
    cue_name: string;
    run_number: number;
    state: "ready" | "open" | "closed" | "revealed" | "skipped";
    state_version: number;
    interactions: SnapshotInteraction[];
  };
};

export type Aggregate = {
  interaction_type: string;
  total_responses: number;
  understood?: number;
  not_understood?: number;
  understood_percent?: number;
  green?: number;
  yellow?: number;
  red?: number;
  green_percent?: number;
  yellow_percent?: number;
  red_percent?: number;
  options?: Array<{ option_id: string; label: string; count: number }>;
  entries?: Array<{ text: string; count: number }>;
  pinned?: string[];
};

export type Question = {
  id: string;
  cue_run_id: string;
  body: string;
  status: "pending" | "visible" | "answered" | "hidden" | "pinned" | "highlighted";
  votes: number;
  voted_by_me: boolean;
  created_at: string;
};

export type LiveView = {
  snapshot: SessionSnapshot;
  audience_count: number;
  aggregates: Array<{
    cue_run_id: string;
    interaction_id: string;
    aggregate: Aggregate;
  }>;
  questions: Question[];
  my_responses: Array<{
    interaction_id: string;
    payload: Record<string, unknown>;
  }>;
};

export type SessionCommand =
  | { type: "open_lobby" | "start" | "pause" | "resume" | "end" | "show_join_qr" | "show_cue" | "reopen_session" }
  | { type: "prepare_cue"; cue_id: string }
  | { type: "open_cue" | "close_cue" | "reopen_cue" | "reveal_cue" | "skip_cue" };
