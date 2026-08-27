import type { MessageKey } from "@slide-helper/i18n";

export type Translate = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string;
