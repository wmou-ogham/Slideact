import { describe, expect, it } from "vitest";

import { resolveLocale, supportedLocales, translate } from "./index";

describe("i18n", () => {
  it("ships both required locales", () => {
    expect(supportedLocales).toEqual(["zh-TW", "en"]);
  });

  it("resolves Chinese variants to zh-TW", () => {
    expect(resolveLocale("zh-Hant-TW")).toBe("zh-TW");
    expect(resolveLocale("en-US")).toBe("en");
  });

  it("translates shared keys in both locales", () => {
    expect(translate("zh-TW", "status.ready")).toBe("已就緒");
    expect(translate("en", "status.ready")).toBe("Ready");
  });
});
