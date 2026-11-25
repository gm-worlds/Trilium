import { isMobile } from "../../../services/utils.js";
import { addVoiceNoteToConfig } from "./editor_plugin.js";

/** `buildConfig()` of the text editor: adds the voice note inside a frame. */
export function tfReachEditorConfig<T extends object>(config: T): T {
    const inFrame = typeof window !== "undefined" && window.parent !== window;
    return addVoiceNoteToConfig(config, { inFrame, isMobile: isMobile() });
}
