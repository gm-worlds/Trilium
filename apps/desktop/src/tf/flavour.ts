/**
 * The Taskforce Notes build flavour (`TF_DESKTOP=1`). The build bakes `process.env.TF_DESKTOP` and
 * `process.env.TF_DESKTOP_BUILD` into the bundle (`tfDesktopDefines()` in `scripts/build-utils.ts`);
 * in dev (`tsx`) they are read from the environment. The data folder and port are claimed by the
 * server's `data_dir.ts` (`apps/server/src/tf/desktop_env.ts`).
 *
 * Kept free of Electron imports: the forge config reads the names from here at packaging time.
 */
import path from "path";

import { isTfDesktopBuild, parseBuildNumber } from "../../../server/src/tf/desktop_env";

export {
    applyTfDesktopEnv, assertNotStockDataDir, claimTfDesktopEnv, parseBuildNumber, resolveTfDataDir, TF_DEFAULT_PORT, TF_PRODUCT_NAME,
    UPSTREAM_DATA_ENV
} from "../../../server/src/tf/desktop_env";

export const TF_DESKTOP = isTfDesktopBuild();

/** The build number the update feed compares (`TF_DESKTOP_BUILD`, an integer). */
export const TF_DESKTOP_BUILD = parseBuildNumber(process.env.TF_DESKTOP_BUILD);

export const TF_URL_SCHEME = "taskforce-notes";
export const TF_DEFAULT_BUNDLE_ID = "org.triliumtf.notes";

/** Throws when the server resolved another data folder than the one Taskforce Notes claimed. */
export function assertTfDataDirInUse(inUse: string, expected: string) {
    if (path.resolve(inUse) !== path.resolve(expected)) {
        throw new Error(`Taskforce Notes expected its data folder ${expected}, but the app resolved ${inUse}.`);
    }
}
