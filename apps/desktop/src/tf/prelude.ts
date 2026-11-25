/**
 * First import of `main.ts`. In a Taskforce Notes build it claims the app's own data folder,
 * Chromium profile and port (also claimed by `data_dir.ts` itself, which the split bundle can
 * evaluate before this module), and moves a previous notebook aside when a fresh start was asked
 * for, before the database is opened. Without `TF_DESKTOP` it does nothing.
 */
import { claimTfDesktopEnv } from "./flavour";
import { runFreshStartIfAsked } from "./fresh_start";

export const TF_DATA_DIR: string | null = prepare();

function prepare() {
    const dataDir = claimTfDesktopEnv();
    if (!dataDir || process.env.TRILIUM_INTEGRATION_TEST) {
        return dataDir;
    }
    try {
        runFreshStartIfAsked(dataDir);
    } catch (e) {
        console.error("Taskforce Notes could not move the previous notebook aside:", e);
    }
    return dataDir;
}
