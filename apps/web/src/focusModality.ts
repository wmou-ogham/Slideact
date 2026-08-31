const FOCUS_NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowRight",
  "ArrowDown",
  "ArrowLeft",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

type FocusKeyEvent = Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey">;

export function isFocusNavigationKey(event: FocusKeyEvent) {
  return !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && FOCUS_NAVIGATION_KEYS.has(event.key);
}

/**
 * Browsers may match :focus-visible for pointer-focused form controls.
 * Track the actual input modality so focus rings only appear for keyboard navigation.
 */
export function installFocusModalityTracking(target: Document = document) {
  const root = target.documentElement;
  const usePointer = () => {
    root.dataset.focusModality = "pointer";
  };
  const useKeyboard = (event: KeyboardEvent) => {
    if (isFocusNavigationKey(event)) root.dataset.focusModality = "keyboard";
  };

  usePointer();
  target.addEventListener("pointerdown", usePointer, true);
  target.addEventListener("keydown", useKeyboard, true);

  return () => {
    target.removeEventListener("pointerdown", usePointer, true);
    target.removeEventListener("keydown", useKeyboard, true);
  };
}
