import type { Translate } from "../i18n";
import type { Cue, Interaction } from "../types";

export function typeName(t: Translate, type: Interaction["interaction_type"]) {
  return t(
    `interaction.${type === "single_choice"
      ? "choice"
      : type === "word_cloud"
        ? "wordCloud"
        : type === "audience_qa"
          ? "audienceQa"
          : type}`,
  );
}

export type InteractionResultSettings = {
  background_question: boolean;
  publish_results: boolean;
};

export function defaultResultSettings(type: Interaction["interaction_type"]): InteractionResultSettings {
  const backgroundQuestion = type === "understanding";
  return {
    background_question: backgroundQuestion,
    publish_results: !backgroundQuestion,
  };
}

export function interactionResultSettings(
  settings: Record<string, unknown>,
  _type: Interaction["interaction_type"] = "single_choice",
): InteractionResultSettings {
  // Missing persisted settings predate the switches. Keep them private until
  // reveal; new interactions always write explicit defaults from the editor.
  const defaults = { background_question: false, publish_results: false };
  const results = settings.results;
  const resultSettings = typeof results === "object" && results !== null
    ? results as Record<string, unknown>
    : {};
  const legacyVisibility = resultSettings.audience_visibility;
  const backgroundQuestion = typeof resultSettings.background_question === "boolean"
    ? resultSettings.background_question
    : legacyVisibility === "background" || legacyVisibility === "presenter_only"
      ? true
      : defaults.background_question;
  const publishResults = typeof resultSettings.publish_results === "boolean"
    ? resultSettings.publish_results
    : legacyVisibility === "live"
      ? true
      : legacyVisibility === "background"
        || legacyVisibility === "presenter_only"
        || legacyVisibility === "question_only"
        || legacyVisibility === "after_reveal"
        ? false
        : defaults.publish_results;
  return {
    background_question: backgroundQuestion,
    publish_results: backgroundQuestion ? false : publishResults,
  };
}

export function resultSettingsPayload(settings: InteractionResultSettings) {
  const normalized = {
    background_question: settings.background_question,
    publish_results: settings.background_question ? false : settings.publish_results,
  };
  return {
    ...normalized,
    // Keep the old field for older clients and existing exports.
    audience_visibility: normalized.background_question
      ? "background"
      : normalized.publish_results
        ? "live"
        : "after_reveal",
  };
}

export function projectionInteractionIsVisible(
  interaction: Pick<Interaction, "interaction_type" | "settings">,
) {
  return !interactionResultSettings(interaction.settings, interaction.interaction_type).background_question;
}

export function projectionInteractionShowsResults(
  interaction: Pick<Interaction, "interaction_type" | "settings">,
  cueState: "ready" | "open" | "closed" | "revealed" | "skipped",
) {
  const results = interactionResultSettings(interaction.settings, interaction.interaction_type);
  return !results.background_question && (results.publish_results || cueState === "revealed");
}

export function cueNavigationLabel(t: Translate, cue: Cue) {
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
