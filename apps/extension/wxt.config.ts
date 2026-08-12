import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    default_locale: "en",
    minimum_chrome_version: "116",
    permissions: ["storage"],
    host_permissions: ["https://docs.google.com/presentation/*"],
    action: {
      default_title: "__MSG_extensionName__",
    },
  },
});
