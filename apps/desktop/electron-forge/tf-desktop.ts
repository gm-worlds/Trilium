/**
 * tf: packaging of Taskforce Notes (`TF_DESKTOP=1`), merged into `packagerConfig` by
 * `forge.config.ts`. Everything that names a person, a team or a domain comes from the build
 * machine's environment, never from this repository:
 *
 * - `TF_DESKTOP_BUNDLE_ID`: the bundle id (default `org.triliumtf.notes`);
 * - `TF_DESKTOP_BUILD`: the integer build number, the bundle's `CFBundleVersion`;
 * - `TF_SIGN_IDENTITY`: the Developer ID Application identity to sign with (hardened runtime and
 *   Electron's per-helper entitlements from `@electron/osx-sign`); unsigned without it;
 * - `TF_NOTARY_PROFILE`: the `notarytool` keychain profile to notarize with; needs the identity;
 * - `TF_DESKTOP_ICON_DIR`: a folder with the app icon (`icon.icon` for macOS 26 and later,
 *   `icon.icns`) and the installer disk's `volume.icns`; upstream's icons without it.
 */
import type { ForgeConfig } from "@electron-forge/shared-types";
import { existsSync } from "fs";
import path from "path";

import { parseBuildNumber, TF_DEFAULT_BUNDLE_ID, TF_DESKTOP, TF_PRODUCT_NAME, TF_URL_SCHEME } from "../src/tf/flavour.js";

export const TF_DESKTOP_EXECUTABLE_NAME: string | null = TF_DESKTOP ? "taskforce-notes" : null;

type PackagerConfig = NonNullable<ForgeConfig["packagerConfig"]>;

export function tfDesktopPackagerConfig(env: NodeJS.ProcessEnv = process.env): Partial<PackagerConfig> {
    if (env.TF_DESKTOP !== "1") {
        return {};
    }
    const build = parseBuildNumber(env.TF_DESKTOP_BUILD);
    if (!build) {
        throw new Error("TF_DESKTOP_BUILD must be a positive integer for a Taskforce Notes build.");
    }
    const identity = env.TF_SIGN_IDENTITY?.trim();
    const notaryProfile = env.TF_NOTARY_PROFILE?.trim();
    if (notaryProfile && !identity) {
        throw new Error("TF_NOTARY_PROFILE needs TF_SIGN_IDENTITY: only a signed app can be notarized.");
    }
    const iconDir = tfDesktopIconDir(env);
    return {
        name: TF_PRODUCT_NAME,
        ...(iconDir ? { icon: path.join(iconDir, "icon") } : {}),
        appBundleId: env.TF_DESKTOP_BUNDLE_ID?.trim() || TF_DEFAULT_BUNDLE_ID,
        appCategoryType: "public.app-category.productivity",
        buildVersion: String(build),
        protocols: [ { name: TF_PRODUCT_NAME, schemes: [ TF_URL_SCHEME ] } ],
        ...(identity ? { osxSign: { identity, optionsForFile: () => ({ hardenedRuntime: true }) } } : {}),
        ...(notaryProfile ? { osxNotarize: { keychainProfile: notaryProfile } } : {})
    };
}

/** The installer disk's icon of a Taskforce Notes build with its own icons, else `null`. */
export function tfDesktopVolumeIcon(env: NodeJS.ProcessEnv = process.env): string | null {
    const iconDir = env.TF_DESKTOP === "1" ? tfDesktopIconDir(env) : null;
    return iconDir ? path.join(iconDir, "volume.icns") : null;
}

/** `TF_DESKTOP_ICON_DIR`, checked: a set folder must hold every icon the build takes from it. */
function tfDesktopIconDir(env: NodeJS.ProcessEnv): string | null {
    const dir = env.TF_DESKTOP_ICON_DIR?.trim();
    if (!dir) {
        return null;
    }
    const missing = [ "icon.icon", "icon.icns", "volume.icns" ].filter((name) => !existsSync(path.join(dir, name)));
    if (missing.length > 0) {
        throw new Error(`TF_DESKTOP_ICON_DIR has no ${missing.join(", ")}.`);
    }
    return path.resolve(dir);
}
