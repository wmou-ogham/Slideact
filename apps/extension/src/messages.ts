import type { SlidePosition } from "./presentation";

export const DEFAULT_SERVER_URL = "https://slideact.mou.tw";

export const MESSAGE_TYPES = {
  getStatus: "slide_helper.get_status",
  pair: "slide_helper.pair",
  position: "slide_helper.presentation_position",
  pollNavigation: "slide_helper.poll_navigation",
  setMode: "slide_helper.set_mode",
  statusUpdated: "slide_helper.status_updated",
} as const;

export type SyncMode = "auto" | "manual";
export type NavigationDirection = "previous" | "next";

export interface NavigationCommand {
  id: string;
  direction: NavigationDirection;
}

export interface ExtensionStatus {
  mode: SyncMode;
  position: SlidePosition | null;
  updatedAt: number | null;
  serverUrl: string;
  sessionId: string | null;
  token: string | null;
  overlayUrl: string | null;
  lastError: string | null;
}

export type ExtensionMessage =
  | { type: typeof MESSAGE_TYPES.getStatus }
  | { type: typeof MESSAGE_TYPES.pair; payload: { code: string; serverUrl: string } }
  | { type: typeof MESSAGE_TYPES.position; payload: SlidePosition }
  | { type: typeof MESSAGE_TYPES.pollNavigation }
  | { type: typeof MESSAGE_TYPES.setMode; payload: { mode: SyncMode } }
  | { type: typeof MESSAGE_TYPES.statusUpdated; payload: ExtensionStatus };

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  return Object.values(MESSAGE_TYPES).includes(
    (value as { type: string }).type as (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES],
  );
}
