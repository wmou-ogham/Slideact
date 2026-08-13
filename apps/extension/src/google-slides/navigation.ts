import type { NavigationDirection } from "../messages";

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

export function navigatePresentation(direction: NavigationDirection, root: Document = document) {
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
