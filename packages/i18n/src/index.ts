export const supportedLocales = ["zh-TW", "en"] as const;

export type SupportedLocale = (typeof supportedLocales)[number];

