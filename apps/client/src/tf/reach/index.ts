/**
 * The reach features inside Taskforce: voice notes (`tf-voice-1`), share links that end
 * (`tf-share-1`) and search in the person's other notebooks (`tf-search-1`). Started by
 * `startTf()` once the page is known to be embedded.
 */
import { registerCapability } from "../bridge.js";
import { addTfReachTranslations } from "./translations.js";

export const TF_REACH_CAPABILITIES = [ "tf-voice-1", "tf-share-1", "tf-search-1" ];

export function installTfReach() {
    addTfReachTranslations();
    for (const capability of TF_REACH_CAPABILITIES) {
        registerCapability(capability);
    }
}
