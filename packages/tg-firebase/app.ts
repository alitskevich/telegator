import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { PROJECT_ID } from "tg-configs/firebase";

/**
 * The one Admin app. Under the emulators the SDK finds them by the
 * `*_EMULATOR_HOST` variables, so nothing here branches on the environment.
 */
const app = getApps()[0] ?? initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? PROJECT_ID });

export const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });

export const auth = getAuth(app);

export const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";
