import { describe, expect, it } from "vitest";

import { firstSlideIndex, isGoogleSlidesSlideshow, parseGoogleSlidesUrl, positionKey } from "./detector";

describe("parseGoogleSlidesUrl", () => {
  it("extracts the deck and slide IDs from presentation mode", () => {
    expect(
      parseGoogleSlidesUrl(
        "https://docs.google.com/presentation/d/deck-123/present?slide=id.g2abc#slide=id.g5xyz",
        42,
      ),
    ).toEqual({
      deckId: "deck-123",
      slideId: "g2abc",
      slideIndex: null,
      source: "url",
      detectedAt: 42,
    });
  });

  it("reads the slide ID from a hash when the query is absent", () => {
    expect(
      parseGoogleSlidesUrl("https://docs.google.com/presentation/d/a-deck/edit#slide=id.gabc", 7),
    ).toMatchObject({ deckId: "a-deck", slideId: "gabc", detectedAt: 7 });
  });

  it("returns a deck position when Google Slides has no slide token", () => {
    expect(parseGoogleSlidesUrl("https://docs.google.com/presentation/d/a-deck/edit", 9)).toMatchObject({
      deckId: "a-deck",
      slideId: null,
      detectedAt: 9,
    });
  });

  it("rejects unrelated and malformed URLs", () => {
    expect(parseGoogleSlidesUrl("https://example.com/presentation/d/a-deck/edit")).toBeNull();
    expect(parseGoogleSlidesUrl("not a URL")).toBeNull();
  });
});

describe("isGoogleSlidesSlideshow", () => {
  it("accepts present, preview, htmlpresent and embed surfaces", () => {
    expect(isGoogleSlidesSlideshow("https://docs.google.com/presentation/d/deck/present")).toBe(true);
    expect(isGoogleSlidesSlideshow("https://docs.google.com/presentation/d/deck/preview")).toBe(true);
    expect(isGoogleSlidesSlideshow("https://docs.google.com/presentation/d/deck/htmlpresent")).toBe(true);
    expect(isGoogleSlidesSlideshow("https://docs.google.com/presentation/d/deck/embed")).toBe(true);
  });

  it("rejects the editor so overlay injection cannot cover authoring", () => {
    expect(isGoogleSlidesSlideshow("https://docs.google.com/presentation/d/deck/edit")).toBe(false);
    expect(isGoogleSlidesSlideshow("https://docs.google.com/presentation/d/deck/edit#slide=id.p")).toBe(false);
    expect(isGoogleSlidesSlideshow("https://example.com/presentation/d/deck/present")).toBe(false);
  });
});

describe("firstSlideIndex", () => {
  it("treats Google's id.p token as the first slide when the DOM has no index", () => {
    expect(firstSlideIndex("p")).toBe(0);
    expect(firstSlideIndex("g3f7c2fe3ef4_1_84")).toBeNull();
    expect(firstSlideIndex(null)).toBeNull();
  });
});

describe("positionKey", () => {
  it("ignores timestamps and detection source when deduplicating", () => {
    expect(
      positionKey({
        deckId: "deck",
        slideId: "slide",
        slideIndex: 4,
        source: "url",
        detectedAt: 1,
      }),
    ).toBe("deck:slide:4");
  });
});
