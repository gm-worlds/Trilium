/**
 * Environment of an engine started by the Taskforce notes gateway. `TF_EMBED=1` turns the
 * embedding on; without it every `tf` hook stays inert and the server behaves like upstream.
 */
import { app_info as appInfo } from "@triliumnext/core";
import fs from "fs";
import path from "path";

import { getResourceDir } from "../services/utils.js";

export const TF_SOURCE_URL = "https://github.com/gm-worlds/trilium";

export function isTfEmbedEnv(env: NodeJS.ProcessEnv = process.env) {
    return env.TF_EMBED === "1" || env.TF_EMBED === "true";
}

export function getTfGatewayKey() {
    return process.env.TF_GATEWAY_KEY ?? "";
}

export function getTfNotebookId() {
    return process.env.TF_NOTEBOOK_ID ?? "";
}

export function getTfParentOrigins(): string[] {
    return (process.env.TF_PARENT_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
}

export function getTfEventsUrl() {
    return process.env.TF_EVENTS_URL ?? "";
}

export function getUpstreamVersion() {
    return appInfo.appVersion;
}

let engineVersion: string | null = null;

/**
 * The fork's version (`0.107.0+tf.3`), written next to `main.mjs` by `scripts/tf-install-local.sh`.
 * A build that was not installed by the script reports `<upstream>+tf.dev`.
 */
export function getTfEngineVersion() {
    if (engineVersion) {
        return engineVersion;
    }

    try {
        const file = path.join(getResourceDir(), "tf-version.json");
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { version?: unknown };
        if (typeof parsed.version === "string" && parsed.version) {
            engineVersion = parsed.version;
            return engineVersion;
        }
    } catch {
        // No version file: a development build.
    }

    engineVersion = `${getUpstreamVersion()}+tf.dev`;
    return engineVersion;
}
