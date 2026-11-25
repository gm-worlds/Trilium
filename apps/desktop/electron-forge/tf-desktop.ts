/**
 * tf: packaging of Taskforce Notes (`TF_DESKTOP=1`), merged into `packagerConfig` by
 * `forge.config.ts`. Everything that names a person, a team or a domain comes from the build
 * machine's environment, never from this repository:
 *
 * - `TF_DESKTOP_BUNDLE_ID`: the bundle id (default `org.triliumtf.notes`);
 * - `TF_DESKTOP_BUILD`: the integer build number, the bundle's `CFBundleVersion`;
 * - `TF_SIGN_IDENTITY`: the Developer ID Application identity to sign with (hardened runtime and
 *   Electron's per-helper entitlements from `@electron/osx-sign`); unsigned without it;
 * - `TF_NOTARY_PROFILE`: the `notarytool` keychain profile to notarize with; needs the identity.
 */
import type { ForgeConfig } from "@electron-forge/shared-types";

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
    return {
        name: TF_PRODUCT_NAME,
        appBundleId: env.TF_DESKTOP_BUNDLE_ID?.trim() || TF_DEFAULT_BUNDLE_ID,
        appCategoryType: "public.app-category.productivity",
        buildVersion: String(build),
        protocols: [ { name: TF_PRODUCT_NAME, schemes: [ TF_URL_SCHEME ] } ],
        ...(identity ? { osxSign: { identity, optionsForFile: () => ({ hardenedRuntime: true }) } } : {}),
        ...(notaryProfile ? { osxNotarize: { keychainProfile: notaryProfile } } : {})
    };
}
