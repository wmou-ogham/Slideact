import type { NavigationCommand, NavigationDirection } from "../messages";

const PREVIOUS_SELECTORS = [
  ".punch-viewer-nav-v2-prev",
  ".punch-viewer-nav-v2-left",
  ".punch-viewer-left",
  'button[aria-label="Previous slide"]',
  'button[aria-label="Previous"]',
  'button[aria-label="上一張投影片"]',
  'button[aria-label="上一頁"]',
  '[aria-label="Previous slide"]',
  '[aria-label="Previous"]',
  '[aria-label="上一張投影片"]',
  '[aria-label="上一頁"]',
];

const NEXT_SELECTORS = [
  ".punch-viewer-nav-v2-next",
  ".punch-viewer-nav-v2-right",
  ".punch-viewer-right",
  'button[aria-label="Next slide"]',
  'button[aria-label="Next"]',
  'button[aria-label="下一張投影片"]',
  'button[aria-label="下一頁"]',
  '[aria-label="Next slide"]',
  '[aria-label="Next"]',
  '[aria-label="下一張投影片"]',
  '[aria-label="下一頁"]',
];

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

export function navigationSelectors(direction: NavigationDirection): readonly string[] {
  return direction === "previous" ? PREVIOUS_SELECTORS : NEXT_SELECTORS;
}

function slideIdForElement(element: HTMLElement): string | null {
  for (const attribute of ["data-slide-id", "data-page-id", "data-id"]) {
    const value = element.getAttribute(attribute);
    if (value) return value.replace(/^id\./, "");
  }
  const match = element.className.match(/(?:slide|page)[-_]([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? null;
}

export function presentationTargetUrl(href: string, slideId: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.hostname !== "docs.google.com" || !url.pathname.includes("/presentation/d/")) return null;
  const target = `id.${slideId.replace(/^id\./, "")}`;
  if (/\/edit(?:\/|$)/.test(url.pathname)) {
    url.hash = `slide=${encodeURIComponent(target)}`;
  } else {
    url.searchParams.set("slide", target);
  }
  return url.toString();
}

export function navigateToPresentationTarget(
  command: Pick<NavigationCommand, "slide_id" | "slide_index">,
  root: Document = document,
  locationRoot: Pick<Location, "href" | "assign"> = window.location,
) {
  const thumbnails = Array.from(root.querySelectorAll<HTMLElement>(EDITOR_THUMBNAILS));
  let target: HTMLElement | undefined;
  if (command.slide_id) {
    target = thumbnails.find((thumbnail) => slideIdForElement(thumbnail) === command.slide_id?.replace(/^id\./, ""));
  } else if (command.slide_index !== undefined) {
    target = thumbnails[command.slide_index];
  }
  if (target) {
    target.scrollIntoView({ block: "nearest" });
    target.click();
    return true;
  }
  if (command.slide_id) {
    const targetUrl = presentationTargetUrl(locationRoot.href, command.slide_id);
    if (targetUrl && targetUrl !== locationRoot.href) {
      locationRoot.assign(targetUrl);
      return true;
    }
  }
  return false;
}

export function navigatePresentation(
  commandOrDirection: NavigationCommand | NavigationDirection,
  root: Document = document,
) {
  const command = typeof commandOrDirection === "string" ? null : commandOrDirection;
  if (command && (command.slide_id || command.slide_index !== undefined) && navigateToPresentationTarget(command, root)) {
    return true;
  }
  const direction: NavigationDirection = typeof commandOrDirection === "string"
    ? commandOrDirection
    : commandOrDirection.direction;
  for (const selector of navigationSelectors(direction)) {
    const control = root.querySelector<HTMLElement>(selector);
    if (control && control.getAttribute("aria-disabled") !== "true") {
      control.click();
      return true;
    }
  }

  const selected = root.querySelector<HTMLElement>(EDITOR_SELECTED);
  if (selected) {
    const thumbnails = Array.from(root.querySelectorAll<HTMLElement>(EDITOR_THUMBNAILS));
    const currentIndex = thumbnails.indexOf(selected);
    const targetIndex = currentIndex + (direction === "previous" ? -1 : 1);
    const target = thumbnails[targetIndex];
    if (target) {
      target.scrollIntoView({ block: "nearest" });
      target.click();
      return true;
    }
  }

  const key = direction === "previous" ? "ArrowLeft" : "ArrowRight";
  const target = root.activeElement instanceof HTMLElement ? root.activeElement : root.body;
  target?.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true }));
  target?.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true }));
  return false;
}
