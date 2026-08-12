import { catalogs, type MessageKey } from "./messages";

export const supportedLocales = ["zh-TW", "en"] as const;

export type SupportedLocale = (typeof supportedLocales)[number];

export { type MessageKey } from "./messages";

export function resolveLocale(value: string | null | undefined): SupportedLocale {
  const normalized = value?.toLowerCase();
  return normalized?.startsWith("zh") ? "zh-TW" : "en";
}

export function translate(
  locale: SupportedLocale,
  key: MessageKey,
  params: Readonly<Record<string, string | number>> = {},
): string {
  const template = catalogs[locale][key];

  return Object.entries(params).reduce(
    (message, [name, replacement]) =>
      message.replaceAll(`{${name}}`, String(replacement)),
    template,
  );
}
