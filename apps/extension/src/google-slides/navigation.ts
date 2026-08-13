import type { NavigationDirection } from "../messages";

const PREVIOUS_SELECTORS = [
  ".punch-viewer-nav-v2-prev",
  'button[aria-label="Previous slide"]',
  'button[aria-label="Previous"]',
  'button[aria-label="上一張投影片"]',
  'button[aria-label="上一頁"]',
];

const NEXT_SELECTORS = [
  ".punch-viewer-nav-v2-next",
  'button[aria-label="Next slide"]',
  'button[aria-label="Next"]',
  'button[aria-label="下一張投影片"]',
  'button[aria-label="下一頁"]',
];

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

  const key = direction === "previous" ? "ArrowLeft" : "ArrowRight";
  const target = root.activeElement instanceof HTMLElement ? root.activeElement : root.body;
  target?.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true }));
  target?.dispatchEvent(new KeyboardEvent("keyup", { key, code: key, bubbles: true }));
  return false;
}
