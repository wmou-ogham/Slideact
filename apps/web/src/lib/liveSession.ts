import { useCallback, useEffect, useRef, useState } from "react";

import { apiJson, uuid } from "../api";
import type { LiveView, SessionCommand, SessionSnapshot } from "../types";

/** Polling cadence per live surface, previously scattered magic numbers. */
export const LIVE_POLL_INTERVAL_MS = {
  audience: 3500,
  remote: 3000,
  projection: 2000,
  overlay: 2000,
} as const;

export async function loadLiveView(sessionId: string, token: string) {
  return apiJson<LiveView>(`/api/live/sessions/${sessionId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

export async function sendCommand(
  sessionId: string,
  expectedVersion: number,
  command: SessionCommand,
  token?: string,
) {
  const response = await apiJson<{ snapshot: SessionSnapshot }>(
    `/api/sessions/${sessionId}/commands`,
    {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
      body: JSON.stringify({ idempotency_key: uuid(), expected_version: expectedVersion, command }),
    },
  );
  return response.snapshot;
}

export async function pinWordCloud(
  sessionId: string,
  token: string,
  interactionId: string,
  text: string,
  pinned: boolean,
) {
  await apiJson(`/api/sessions/${sessionId}/interactions/${interactionId}/word-cloud/pin`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ text, pinned }),
  });
}

export function aggregateFor(live: LiveView | null, interactionId: string) {
  return live?.aggregates.find((item) => item.interaction_id === interactionId)?.aggregate;
}

/**
 * Keeps the latest responses visible while the backend briefly reports an
 * empty aggregate for the same cue (e.g. right after a reopen).
 */
export function rememberCueLive(cache: Record<string, LiveView>, live: LiveView) {
  const cueId = live.snapshot.current_cue_run?.cue_id;
  if (!cueId) return live;
  const hasResponses = live.aggregates.some((item) => (item.aggregate.total_responses ?? 0) > 0)
    || live.questions.length > 0;
  if (hasResponses) {
    cache[cueId] = live;
    return live;
  }
  const remembered = cache[cueId];
  if (!remembered || !canReuseRememberedCue(remembered, live)) return live;
  return {
    ...live,
    aggregates: remembered.aggregates,
    questions: live.questions.length ? live.questions : remembered.questions,
  };
}

function canReuseRememberedCue(remembered: LiveView, live: LiveView) {
  const rememberedRun = remembered.snapshot.current_cue_run;
  const currentRun = live.snapshot.current_cue_run;
  if (!rememberedRun || !currentRun
    || rememberedRun.id !== currentRun.id
    || rememberedRun.state !== "revealed"
    || currentRun.state !== "revealed") {
    return false;
  }
  return JSON.stringify(rememberedRun.interactions) === JSON.stringify(currentRun.interactions);
}

export type LiveRefreshOrder = {
  nextRequestId: number;
  appliedRequestId: number;
};

export function createLiveRefreshOrder(): LiveRefreshOrder {
  return { nextRequestId: 0, appliedRequestId: 0 };
}

export function beginLiveRefresh(order: LiveRefreshOrder) {
  order.nextRequestId += 1;
  return order.nextRequestId;
}

export function shouldApplyLiveRefresh(order: LiveRefreshOrder, requestId: number) {
  if (requestId < order.appliedRequestId) return false;
  order.appliedRequestId = requestId;
  return true;
}

export function connectLiveSocket(token: string, topic: string, refresh: () => Promise<void>) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${protocol}//${location.host}/api/ws?token=${encodeURIComponent(token)}`);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "subscribe", topic })));
  socket.addEventListener("message", (event) => {
    try {
      const message = JSON.parse(String(event.data)) as { type?: string };
      if (message.type === "event") refresh().catch(() => undefined);
    } catch {
      // The server only sends JSON protocol messages; polling remains the fallback.
    }
  });
  return () => socket.close();
}

type UseLiveSessionOptions = {
  sessionId: string;
  token: string;
  topic: string;
  pollMs: number;
  /** Load once on mount (audience seeds its view from the join response instead). */
  immediate?: boolean;
  /** Gate everything until e.g. the audience member has joined. */
  enabled?: boolean;
  /** Called with every freshly loaded view (before rememberCueLive merging). */
  onLive?: (live: LiveView) => void;
  /** Called when the initial load fails, typically to flag an invalid token. */
  onInitialError?: (cause: unknown) => void;
};

/**
 * Shared subscription logic for the four live surfaces
 * (audience / remote / projection / overlay): fetch the live view,
 * poll it, refresh on websocket events and smooth over empty aggregates.
 */
export function useLiveSession(options: UseLiveSessionOptions) {
  const { sessionId, token, topic, pollMs, immediate = true, enabled = true } = options;
  const [live, setLive] = useState<LiveView | null>(null);
  const cueLiveCache = useRef<Record<string, LiveView>>({});
  const refreshOrder = useRef(createLiveRefreshOrder());
  const onLiveRef = useRef(options.onLive);
  onLiveRef.current = options.onLive;
  const onInitialErrorRef = useRef(options.onInitialError);
  onInitialErrorRef.current = options.onInitialError;

  const refresh = useCallback(async () => {
    if (!token) throw new Error("live_token_missing");
    const requestId = beginLiveRefresh(refreshOrder.current);
    const next = await loadLiveView(sessionId, token);
    if (!shouldApplyLiveRefresh(refreshOrder.current, requestId)) return;
    setLive(rememberCueLive(cueLiveCache.current, next));
    onLiveRef.current?.(next);
  }, [sessionId, token]);

  useEffect(() => {
    if (!enabled) return;
    if (immediate) refresh().catch((cause) => onInitialErrorRef.current?.(cause));
    const timer = window.setInterval(() => refresh().catch(() => undefined), pollMs);
    return () => window.clearInterval(timer);
  }, [enabled, immediate, pollMs, refresh]);

  useEffect(() => {
    if (!enabled || !token) return;
    return connectLiveSocket(token, topic, refresh);
  }, [enabled, refresh, token, topic]);

  return { live, setLive, refresh };
}
