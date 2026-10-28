import { launchPlatformApp } from "arrmatura-web";
import { firebaseConfig } from "tg-configs/firebase";
import { resources } from "tg-rc/web";
import { emulators as firebaseEmulatorsPorts } from "../../../firebase.json";
import { components } from "./components";
import { appCatalog, ariaSort, clock, num, share, sortIcon, statusTone } from "./functions";

/** The console's entry: one app, signed in through the platform's FirebaseService. */
launchPlatformApp({
  template: "<Infra><App /></Infra>",
  components,
  resources: { ...resources, firebaseConfig, firebaseEmulatorsPorts },
  functions: { appCatalog, ariaSort, clock, num, share, sortIcon, statusTone },
});
