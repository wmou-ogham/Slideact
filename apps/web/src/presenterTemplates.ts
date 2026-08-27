import type { Interaction } from "./types";

export type TemplateKind = "teaching" | "lightning" | "demo";
export type InteractionPurpose = "understanding" | "knowledge" | "opinions" | "questions" | "next" | "mood" | "priorities" | "ideas";
export const interactionPurposes: InteractionPurpose[] = ["understanding", "knowledge", "opinions", "questions", "next", "mood", "priorities", "ideas"];

export function purposeRecommendation(locale: string, purpose: InteractionPurpose): { type: Interaction["interaction_type"]; prompt: string } {
  const zh = locale === "zh-TW";
  const recommendations: Record<InteractionPurpose, { type: Interaction["interaction_type"]; prompt: string }> = {
    understanding: { type: "understanding", prompt: zh ? "目前為止都理解了嗎？" : "How clear is this so far?" },
    knowledge: { type: "single_choice", prompt: zh ? "哪一個選項最符合剛才的重點？" : "Which option best matches the key idea?" },
    opinions: { type: "single_choice", prompt: zh ? "你最認同哪一個方向？" : "Which direction do you agree with most?" },
    questions: { type: "qa", prompt: zh ? "你希望我進一步說明什麼？" : "What would you like me to clarify?" },
    next: { type: "single_choice", prompt: zh ? "接下來最想先看哪個內容？" : "What should we explore next?" },
    mood: { type: "word_cloud", prompt: zh ? "用一個詞描述你現在的感受。" : "Describe the room in one word." },
    priorities: { type: "single_choice", prompt: zh ? "哪一項最值得優先處理？" : "What should be the top priority?" },
    ideas: { type: "word_cloud", prompt: zh ? "用一個短詞分享你的想法。" : "Share one short idea." },
  };
  return recommendations[purpose];
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

export function templates(locale: string): Record<TemplateKind, PresentationTemplate> {
  if (locale === "zh-TW") {
    return {
      teaching: {
        title: "教學互動範本",
        cues: [
          { name: "確認理解度", slide: 2, interactions: [{ type: "understanding", prompt: "目前為止都聽懂了嗎？", description: "即時確認是否需要多做說明" }] },
          { name: "課中小測驗", slide: 5, confirm: true, interactions: [{ type: "single_choice", prompt: "哪一個敘述最符合剛才的觀念？", options: ["選項 A", "選項 B", "選項 C", "選項 D"] }] },
          { name: "學生提問", confirm: true, interactions: [{ type: "qa", prompt: "有什麼地方希望老師再說明？" }] },
        ],
      },
      lightning: {
        title: "Lightning Talk 互動範本",
        cues: [
          { name: "快速暖場", slide: 2, interactions: [{ type: "understanding", prompt: "你曾經遇過這個問題嗎？" }] },
          { name: "一句話收斂", slide: 4, interactions: [{ type: "word_cloud", prompt: "用一個詞形容你最大的收穫" }] },
          { name: "限時問答", confirm: true, interactions: [{ type: "qa", prompt: "把最想問的問題送上來" }] },
        ],
      },
      demo: {
        title: "產品 Demo 互動範本",
        cues: [
          { name: "痛點優先序", slide: 2, interactions: [{ type: "single_choice", prompt: "目前哪個問題最影響你的團隊？", options: ["效率", "協作", "成本", "可見性"] }] },
          { name: "功能清晰度", slide: 4, interactions: [{ type: "understanding", prompt: "這個功能的價值是否清楚？" }] },
          { name: "使用情境", slide: 6, interactions: [{ type: "word_cloud", prompt: "你最想把它用在哪個情境？" }] },
        ],
      },
    };
  }
  return {
    teaching: {
      title: "Interactive teaching template",
      cues: [
        { name: "Check understanding", slide: 2, interactions: [{ type: "understanding", prompt: "Does everything make sense so far?", description: "See whether the room needs another explanation" }] },
        { name: "Knowledge check", slide: 5, confirm: true, interactions: [{ type: "single_choice", prompt: "Which statement best matches the concept?", options: ["Option A", "Option B", "Option C", "Option D"] }] },
        { name: "Student questions", confirm: true, interactions: [{ type: "qa", prompt: "What should the instructor explain again?" }] },
      ],
    },
    lightning: {
      title: "Lightning Talk template",
      cues: [
        { name: "Quick opener", slide: 2, interactions: [{ type: "understanding", prompt: "Have you experienced this problem?" }] },
        { name: "One-word takeaway", slide: 4, interactions: [{ type: "word_cloud", prompt: "Describe your biggest takeaway in one word" }] },
        { name: "Rapid Q&A", confirm: true, interactions: [{ type: "qa", prompt: "Send the one question you most want answered" }] },
      ],
    },
    demo: {
      title: "Product demo template",
      cues: [
        { name: "Pain-point priority", slide: 2, interactions: [{ type: "single_choice", prompt: "Which problem affects your team most?", options: ["Efficiency", "Collaboration", "Cost", "Visibility"] }] },
        { name: "Feature clarity", slide: 4, interactions: [{ type: "understanding", prompt: "Is the value of this feature clear?" }] },
        { name: "Use cases", slide: 6, interactions: [{ type: "word_cloud", prompt: "Where would you use this first?" }] },
      ],
    },
  };
}

export function generatedCueName(locale: string, index: number) {
  return locale === "zh-TW" ? `投影片 ${index}` : `Slide ${index}`;
}
