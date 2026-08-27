import type { Translate } from "../i18n";
import type { Cue, Interaction } from "../types";

export function typeName(t: Translate, type: Interaction["interaction_type"]) {
  return t(
    `interaction.${type === "single_choice" ? "choice" : type === "word_cloud" ? "wordCloud" : type}`,
  );
}

export function defaultVisibility(type: Interaction["interaction_type"]) {
  return type === "single_choice" ? "after_reveal" : "live";
}

export function slideAnchorLabel(t: Translate, cue: Cue) {
  const name = cue.name.trim();
  if (name) return truncateLabel(name, 28);
  const anchor = cue.anchor_value ?? String(cue.position + 1);
  if (/^\d+$/.test(anchor)) return t("cue.slide", { slide: anchor });
  return t("cue.slideId", { id: truncateLabel(anchor, 16) });
}

function truncateLabel(value: string, max: number) {
  return value.length > max ? `${value.slice(0, Math.max(1, max - 1))}…` : value;
}

export function parseOptions(value: FormDataEntryValue | null) {
  return String(value ?? "")
    .split("\n")
    .map((option) => option.trim())
    .filter(Boolean);
}
