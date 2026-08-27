import type { DetectionSource, SlidePosition } from "../presentation";

export type { DetectionSource, SlidePosition } from "../presentation";

interface DomPosition {
  slideId: string | null;
  slideIndex: number | null;
  source: Extract<DetectionSource, "dom-active" | "dom-visible">;
}

const ACTIVE_SLIDE_SELECTORS = [
  '.punch-viewer-page[aria-hidden="false"]',
  '[data-slide-id][aria-current="true"]',
  '[data-slide-id][data-active="true"]',
  '[data-page-id][aria-current="true"]',
];

const SLIDE_CANDIDATE_SELECTOR = [
  ".punch-viewer-page",
  "[data-slide-id]",
  "[data-page-id]",
].join(",");

const EDITOR_THUMBNAILS = [
  ".punch-filmstrip-thumbnail",
  '[role="option"][data-slide-id]',
  '[role="option"][data-page-id]',
].join(",");

const EDITOR_SELECTED = [
  '.punch-filmstrip-thumbnail[aria-selected="true"]',
  '[role="option"][aria-selected="true"][data-slide-id]',
  '[role="option"][aria-selected="true"][data-page-id]',
].join(",");

export const LOCATION_CHANGE_EVENT = "slide-helper:location-change";

const SLIDESHOW_PATH = /\/presentation\/d\/[^/]+\/(present|preview|htmlpresent|embed)(?:\/|$)/;

export function isGoogleSlidesSlideshow(href: string): boolean {
  try {
    const url = new URL(href);
    return url.hostname === "docs.google.com" && SLIDESHOW_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

export function parseGoogleSlidesUrl(
  href: string,
  detectedAt = Date.now(),
): SlidePosition | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.hostname !== "docs.google.com") {
    return null;
  }

  const deckMatch = url.pathname.match(/^\/presentation\/d\/([^/]+)/);
  if (!deckMatch) {
    return null;
  }

  return {
    deckId: decodeURIComponent(deckMatch[1]),
    slideId: readSlideId(url),
    slideIndex: null,
    source: "url",
    detectedAt,
  };
}

export function positionKey(position: SlidePosition): string {
  return [position.deckId, position.slideId ?? "", position.slideIndex ?? ""].join(":");
}

export function readCurrentPosition(
  href: string,
  documentRoot: Document,
  detectedAt = Date.now(),
): SlidePosition | null {
  const urlPosition = parseGoogleSlidesUrl(href, detectedAt);
  if (!urlPosition) {
    return null;
  }

  const domPosition = readDomPosition(documentRoot);
  const merged: SlidePosition = {
    ...urlPosition,
    ...(domPosition ?? {}),
  };
  return {
    ...merged,
    slideIndex: merged.slideIndex ?? readEditorSlideIndex(documentRoot) ?? firstSlideIndex(merged.slideId),
  };
}

export function firstSlideIndex(slideId: string | null): number | null {
  return slideId === "p" ? 0 : null;
}

export class GoogleSlidesDetector {
  private lastPositionKey: string | null = null;
  private mutationObserver: MutationObserver | null = null;
  private pendingTimer: number | null = null;
  private restoreHistory: (() => void) | null = null;

  constructor(
    private readonly onPosition: (position: SlidePosition) => void,
    private readonly debounceMs = 120,
  ) {}

  start(): void {
    if (this.mutationObserver) {
      return;
    }

    this.restoreHistory = observeHistoryChanges(window);
    window.addEventListener("hashchange", this.scheduleDetection);
    window.addEventListener("popstate", this.scheduleDetection);
    window.addEventListener(LOCATION_CHANGE_EVENT, this.scheduleDetection);

    this.mutationObserver = new MutationObserver(this.scheduleDetection);
    this.mutationObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        "aria-current",
        "aria-hidden",
        "class",
        "data-active",
        "data-page-id",
        "data-slide-id",
        "style",
      ],
      childList: true,
      subtree: true,
    });

    this.detect();
  }

  refresh(): void {
    this.lastPositionKey = null;
    this.detect();
  }

  stop(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.restoreHistory?.();
    this.restoreHistory = null;
    window.removeEventListener("hashchange", this.scheduleDetection);
    window.removeEventListener("popstate", this.scheduleDetection);
    window.removeEventListener(LOCATION_CHANGE_EVENT, this.scheduleDetection);

    if (this.pendingTimer !== null) {
      window.clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private readonly scheduleDetection = (): void => {
    if (this.pendingTimer !== null) {
      window.clearTimeout(this.pendingTimer);
    }

    this.pendingTimer = window.setTimeout(() => {
      this.pendingTimer = null;
      this.detect();
    }, this.debounceMs);
  };

  private detect(): void {
    const position = readCurrentPosition(window.location.href, document);
    if (!position) {
      return;
    }

    const nextKey = positionKey(position);
    if (nextKey === this.lastPositionKey) {
      return;
    }

    this.lastPositionKey = nextKey;
    this.onPosition(position);
  }
}

function readSlideId(url: URL): string | null {
  const candidates = [url.searchParams.get("slide"), readHashParameter(url.hash, "slide")];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    return candidate.startsWith("id.") ? candidate.slice(3) : candidate;
  }

  return null;
}

function readHashParameter(hash: string, name: string): string | null {
  const normalizedHash = hash.replace(/^#/, "");
  return new URLSearchParams(normalizedHash).get(name);
}

function readEditorSlideIndex(documentRoot: Document): number | null {
  const selected = documentRoot.querySelector<HTMLElement>(EDITOR_SELECTED);
  if (!selected) {
    return null;
  }
  const thumbnails = Array.from(documentRoot.querySelectorAll<HTMLElement>(EDITOR_THUMBNAILS));
  const index = thumbnails.indexOf(selected);
  return index >= 0 ? index : null;
}

function readDomPosition(documentRoot: Document): DomPosition | null {
  for (const selector of ACTIVE_SLIDE_SELECTORS) {
    const element = documentRoot.querySelector<HTMLElement>(selector);
    if (element && isVisible(element)) {
      return positionFromElement(element, "dom-active");
    }
  }

  const visibleCandidates = Array.from(
    documentRoot.querySelectorAll<HTMLElement>(SLIDE_CANDIDATE_SELECTOR),
  )
    .filter(isVisible)
    .map((element) => ({ element, area: visibleViewportArea(element) }))
    .sort((left, right) => right.area - left.area);

  const bestCandidate = visibleCandidates[0];
  return bestCandidate ? positionFromElement(bestCandidate.element, "dom-visible") : null;
}

function positionFromElement(element: HTMLElement, source: DomPosition["source"]): DomPosition {
  const slideId =
    element.dataset.slideId ??
    element.dataset.pageId ??
    element.id.match(/(?:page|slide)[-_](.+)$/i)?.[1] ??
    null;
  const rawIndex = element.dataset.slideIndex ?? element.getAttribute("aria-posinset");
  const parsedIndex = rawIndex === null || rawIndex === undefined ? Number.NaN : Number(rawIndex);

  return {
    slideId,
    slideIndex: Number.isFinite(parsedIndex)
      ? Math.max(0, parsedIndex - (element.hasAttribute("aria-posinset") ? 1 : 0))
      : null,
    source,
  };
}

function isVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const rectangle = element.getBoundingClientRect();
  return (
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity) !== 0 &&
    rectangle.width > 0 &&
    rectangle.height > 0 &&
    visibleViewportArea(element) > 0
  );
}

function visibleViewportArea(element: HTMLElement): number {
  const rectangle = element.getBoundingClientRect();
  const width = Math.max(0, Math.min(rectangle.right, window.innerWidth) - Math.max(rectangle.left, 0));
  const height = Math.max(
    0,
    Math.min(rectangle.bottom, window.innerHeight) - Math.max(rectangle.top, 0),
  );
  return width * height;
}

function observeHistoryChanges(windowRoot: Window): () => void {
  const originalPushState = windowRoot.history.pushState.bind(windowRoot.history);
  const originalReplaceState = windowRoot.history.replaceState.bind(windowRoot.history);

  windowRoot.history.pushState = (...arguments_) => {
    originalPushState(...arguments_);
    windowRoot.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
  };
  windowRoot.history.replaceState = (...arguments_) => {
    originalReplaceState(...arguments_);
    windowRoot.dispatchEvent(new Event(LOCATION_CHANGE_EVENT));
  };

  return () => {
    windowRoot.history.pushState = originalPushState;
    windowRoot.history.replaceState = originalReplaceState;
  };
}
