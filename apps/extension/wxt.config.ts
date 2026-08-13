import { defineConfig } from "wxt";

export default defineConfig({
  manifest: {
    name: "__MSG_extensionName__",
    description: "__MSG_extensionDescription__",
    default_locale: "en",
    minimum_chrome_version: "116",
    permissions: ["alarms", "storage"],
    host_permissions: [
      "https://docs.google.com/presentation/*",
      "http://10.121.180.185:8080/*",
      "http://localhost:8080/*",
    ],
    action: {
      default_title: "__MSG_extensionName__",
    },
  },
});
