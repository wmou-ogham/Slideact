import { describe, expect, it } from "vitest";

import { navigationSelectors, presentationTargetUrl } from "./navigation";

describe("navigationSelectors", () => {
  it("covers Google Slides presentation controls in English and Traditional Chinese", () => {
    expect(navigationSelectors("previous")).toContain('button[aria-label="Previous slide"]');
    expect(navigationSelectors("previous")).toContain('button[aria-label="上一頁"]');
    expect(navigationSelectors("next")).toContain('button[aria-label="Next slide"]');
    expect(navigationSelectors("next")).toContain('button[aria-label="下一頁"]');
    expect(navigationSelectors("previous")).toContain(".punch-viewer-nav-v2-left");
    expect(navigationSelectors("next")).toContain(".punch-viewer-nav-v2-right");
  });

  it("prefers the stable presentation-viewer classes", () => {
    expect(navigationSelectors("previous")[0]).toBe(".punch-viewer-nav-v2-prev");
    expect(navigationSelectors("next")[0]).toBe(".punch-viewer-nav-v2-next");
  });

  it("builds a Google Slides URL for a slide id target", () => {
    expect(presentationTargetUrl(
      "https://docs.google.com/presentation/d/deck/edit?usp=sharing",
      "p3",
    )).toBe("https://docs.google.com/presentation/d/deck/edit?usp=sharing#slide=id.p3");
  });
});
