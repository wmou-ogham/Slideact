export type Profile = {
  id: string;
  display_name: string;
  locale: string;
  email: string | null;
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
  current_cue_run: null | {
    id: string;
    cue_id: string;
    cue_name: string;
    run_number: number;
    state: "prepared" | "open" | "closed" | "revealed" | "skipped";
    state_version: number;
    interactions: SnapshotInteraction[];
  };
};

export type SessionCommand =
  | { type: "open_lobby" | "start" | "pause" | "resume" | "end" }
  | { type: "prepare_cue"; cue_id: string }
  | { type: "open_cue" | "close_cue" | "reopen_cue" | "reveal_cue" | "skip_cue" };
