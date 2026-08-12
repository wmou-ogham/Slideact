export type DetectionSource = "dom-active" | "dom-visible" | "url";

export interface SlidePosition {
  deckId: string;
  slideId: string | null;
  slideIndex: number | null;
  source: DetectionSource;
  detectedAt: number;
}
