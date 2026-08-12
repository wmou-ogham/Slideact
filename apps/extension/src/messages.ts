import type { SlidePosition } from "./presentation";

export const MESSAGE_TYPES = {
  getStatus: "slide_helper.get_status",
  position: "slide_helper.presentation_position",
  setMode: "slide_helper.set_mode",
} as const;

export type SyncMode = "auto" | "manual";

export interface ExtensionStatus {
  mode: SyncMode;
  position: SlidePosition | null;
  updatedAt: number | null;
}

export type ExtensionMessage =
  | { type: typeof MESSAGE_TYPES.getStatus }
  | { type: typeof MESSAGE_TYPES.position; payload: SlidePosition }
  | { type: typeof MESSAGE_TYPES.setMode; payload: { mode: SyncMode } };

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  return Object.values(MESSAGE_TYPES).includes(
    (value as { type: string }).type as (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES],
  );
}
