import type { Translate } from "../i18n";
import type { Cue, Interaction } from "../types";

export function typeName(t: Translate, type: Interaction["interaction_type"]) {
  return t(
    `interaction.${type === "single_choice" ? "choice" : type === "word_cloud" ? "wordCloud" : type}`,
  );
}

export type InteractionResultVisibility = "background" | "after_reveal";

export function defaultVisibility(type: Interaction["interaction_type"]) {
  return type === "understanding" ? "background" : "after_reveal";
}

export function interactionResultVisibility(settings: Record<string, unknown>): InteractionResultVisibility {
  const results = settings.results;
  const visibility = typeof results === "object" && results !== null
    ? (results as Record<string, unknown>).audience_visibility
    : null;
  return visibility === "background" || visibility === "presenter_only"
    ? "background"
    : "after_reveal";
}

export function projectionInteractionIsVisible(interaction: Pick<Interaction, "settings">) {
  return interactionResultVisibility(interaction.settings) !== "background";
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
