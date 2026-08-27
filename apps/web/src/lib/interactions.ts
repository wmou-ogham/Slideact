import type { Translate } from "../i18n";
import type { Interaction } from "../types";

export function typeName(t: Translate, type: Interaction["interaction_type"]) {
  return t(
    `interaction.${type === "single_choice" ? "choice" : type === "word_cloud" ? "wordCloud" : type}`,
  );
}

export function parseOptions(value: FormDataEntryValue | null) {
  return String(value ?? "")
    .split("\n")
    .map((option) => option.trim())
    .filter(Boolean);
}
