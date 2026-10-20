import { launchPlatformApp } from "arrmatura-web";
import { resources } from "tg-rc/web";
import { components } from "./components";
import { CONFIG_PATH, loadConfig } from "./config";
import { ariaSort, clock, num, share, sortIcon, statusTone } from "./functions";

/**
 * §9.3 — the console's entry point. The deployment's `config.json` is read
 * first, because nothing can sign in without it; the app launches with it as
 * `R.config`.
 */
async function main(): Promise<void> {
  try {
    const config = await loadConfig();
    launchPlatformApp({
      template: "<Infra><App /></Infra>",
      components,
      resources: { ...resources, config },
      functions: { ariaSort, clock, num, share, sortIcon, statusTone },
    });
  } catch (error) {
    // Before launch there is no app to render into, so this is plain DOM.
    const message = document.createElement("p");
    message.textContent = `${resources.app.name}: cannot read ${CONFIG_PATH} (${String(error)})`;
    message.className = "p-6 text-error";
    document.body.replaceChildren(message);
  }
}

void main();
