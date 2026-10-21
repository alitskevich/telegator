import { defineSecret } from "firebase-functions/params";

/** The model key, for the console's *Analyse* on a failed item. */
export const openRouterKey = defineSecret("OPENROUTER_API_KEY");
