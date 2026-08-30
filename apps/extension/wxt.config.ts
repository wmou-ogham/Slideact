import { defineConfig } from "wxt";

export default defineConfig({
  zip: {
    artifactTemplate: "slideact-extension.zip",
  },
  manifest: {
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    default_locale: "en",
    minimum_chrome_version: "116",
    permissions: ["alarms", "storage"],
    host_permissions: [
      "https://docs.google.com/presentation/*",
      "https://slideact.mou.tw/*",
      "http://localhost:8080/*",
      "http://localhost:18666/*",
      "http://127.0.0.1:18666/*",
    ],
    action: {
      default_title: "__MSG_extensionName__",
    },
  },
});
