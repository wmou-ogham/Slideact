import { describe, expect, it } from "vitest";

import { resolveLocale, supportedLocales, translate } from "./index";
import { catalogs } from "./messages";

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

  it("keeps locale keys, values, and interpolation parameters aligned", () => {
    const englishKeys = Object.keys(catalogs.en).sort();
    expect(Object.keys(catalogs["zh-TW"]).sort()).toEqual(englishKeys);
    for (const key of englishKeys) {
      const english = catalogs.en[key as keyof typeof catalogs.en];
      const chinese = catalogs["zh-TW"][key as keyof typeof catalogs.en];
      expect(english.trim(), `${key} English value`).not.toBe("");
      expect(chinese.trim(), `${key} Chinese value`).not.toBe("");
      expect([...english.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort()).toEqual(
        [...chinese.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort(),
      );
    }
  });
});
