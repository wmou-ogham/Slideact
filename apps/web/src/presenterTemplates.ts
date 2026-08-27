import type { Translate } from "./i18n";
import type { Interaction } from "./types";

export type TemplateKind = "teaching" | "lightning" | "demo";
export type InteractionPurpose = "understanding" | "knowledge" | "opinions" | "questions" | "next" | "mood" | "priorities" | "ideas";
export const interactionPurposes: InteractionPurpose[] = ["understanding", "knowledge", "opinions", "questions", "next", "mood", "priorities", "ideas"];

const purposeTypes: Record<InteractionPurpose, Interaction["interaction_type"]> = {
  understanding: "understanding",
  knowledge: "single_choice",
  opinions: "single_choice",
  questions: "qa",
  next: "single_choice",
  mood: "word_cloud",
  priorities: "single_choice",
  ideas: "word_cloud",
};

export function purposeRecommendation(t: Translate, purpose: InteractionPurpose): { type: Interaction["interaction_type"]; prompt: string } {
  return { type: purposeTypes[purpose], prompt: t(`purposePrompt.${purpose}`) };
}

export type TemplateInteraction = {
  type: Interaction["interaction_type"];
  prompt: string;
  description?: string;
  options?: string[];
};
export type PresentationTemplate = {
  title: string;
  cues: Array<{
    name: string;
    slide?: number;
    confirm?: boolean;
    interactions: TemplateInteraction[];
  }>;
};

export function templates(t: Translate): Record<TemplateKind, PresentationTemplate> {
  return {
    teaching: {
      title: t("template.teaching.title"),
      cues: [
        { name: t("template.teaching.check.name"), slide: 2, interactions: [{ type: "understanding", prompt: t("template.teaching.check.prompt"), description: t("template.teaching.check.description") }] },
        { name: t("template.teaching.quiz.name"), slide: 5, confirm: true, interactions: [{ type: "single_choice", prompt: t("template.teaching.quiz.prompt"), options: [t("template.teaching.quiz.optionA"), t("template.teaching.quiz.optionB"), t("template.teaching.quiz.optionC"), t("template.teaching.quiz.optionD")] }] },
        { name: t("template.teaching.questions.name"), confirm: true, interactions: [{ type: "qa", prompt: t("template.teaching.questions.prompt") }] },
      ],
    },
    lightning: {
      title: t("template.lightning.title"),
      cues: [
        { name: t("template.lightning.opener.name"), slide: 2, interactions: [{ type: "understanding", prompt: t("template.lightning.opener.prompt") }] },
        { name: t("template.lightning.takeaway.name"), slide: 4, interactions: [{ type: "word_cloud", prompt: t("template.lightning.takeaway.prompt") }] },
        { name: t("template.lightning.qa.name"), confirm: true, interactions: [{ type: "qa", prompt: t("template.lightning.qa.prompt") }] },
      ],
    },
    demo: {
      title: t("template.demo.title"),
      cues: [
        { name: t("template.demo.pain.name"), slide: 2, interactions: [{ type: "single_choice", prompt: t("template.demo.pain.prompt"), options: [t("template.demo.pain.optionEfficiency"), t("template.demo.pain.optionCollaboration"), t("template.demo.pain.optionCost"), t("template.demo.pain.optionVisibility")] }] },
        { name: t("template.demo.clarity.name"), slide: 4, interactions: [{ type: "understanding", prompt: t("template.demo.clarity.prompt") }] },
        { name: t("template.demo.usecases.name"), slide: 6, interactions: [{ type: "word_cloud", prompt: t("template.demo.usecases.prompt") }] },
      ],
    },
  };
}

export function generatedCueName(t: Translate, index: number) {
  return t("cue.generatedName", { index });
}
