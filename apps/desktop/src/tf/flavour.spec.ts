import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { describe, expect, it } from "vitest";

import { applyTfDesktopEnv, assertTfDataDirInUse, parseBuildNumber, resolveTfDataDir, TF_DEFAULT_PORT } from "./flavour";
import { tfDesktopPackagerConfig, tfDesktopVolumeIcon } from "../../electron-forge/tf-desktop";

const home = "/home-example/person";

describe("Taskforce Notes flavour", () => {
    it("uses its own data folder, never a stock Trilium one", () => {
        expect(resolveTfDataDir({ platform: "darwin", homedir: home }))
            .toBe(`${home}/Library/Application Support/Taskforce Notes`);
        expect(resolveTfDataDir({ platform: "linux", homedir: home })).toBe(`${home}/.local/share/Taskforce Notes`);
        expect(resolveTfDataDir({ platform: "darwin", homedir: home, override: "/tmp/tf-notes-test" })).toBe("/tmp/tf-notes-test");

        for (const override of [
            `${home}/Library/Application Support/trilium-data`,
            `${home}/trilium-data`,
            `${home}/trilium-data/sub`,
            `${home}/Library/Application Support/Trilium Notes`,
            home
        ]) {
            expect(() => resolveTfDataDir({ platform: "darwin", homedir: home, override }), override).toThrow();
        }
    });

    it("rewrites the environment upstream reads its folders and port from", () => {
        const env: NodeJS.ProcessEnv = {
            TRILIUM_DATA_DIR: `${home}/trilium-data`,
            TRILIUM_DOCUMENT_PATH: `${home}/trilium-data/document.db`,
            TRILIUM_ELECTRON_DATA_DIR: "/somewhere",
            TRILIUM_PORT: "37840",
            OTHER: "kept"
        };
        const dir = `${home}/Library/Application Support/Taskforce Notes`;
        applyTfDesktopEnv(env, dir);
        expect(env).toEqual({
            TRILIUM_DATA_DIR: dir,
            TRILIUM_ELECTRON_DATA_DIR: `${dir}/electron-profile`,
            TRILIUM_PORT: TF_DEFAULT_PORT,
            OTHER: "kept"
        });
        expect(() => assertTfDataDirInUse(`${home}/trilium-data`, dir)).toThrow();
        expect(() => assertTfDataDirInUse(`${dir}/`, dir)).not.toThrow();
    });

    it("packages with the build number, the scheme and signing from the environment only", () => {
        expect(parseBuildNumber("12")).toBe(12);
        expect(parseBuildNumber("x")).toBe(0);
        expect(tfDesktopPackagerConfig({})).toEqual({});
        expect(() => tfDesktopPackagerConfig({ TF_DESKTOP: "1" })).toThrow();
        expect(tfDesktopPackagerConfig({ TF_DESKTOP: "1", TF_DESKTOP_BUILD: "7" })).toEqual({
            name: "Taskforce Notes",
            appBundleId: "org.triliumtf.notes",
            appCategoryType: "public.app-category.productivity",
            buildVersion: "7",
            protocols: [ { name: "Taskforce Notes", schemes: [ "taskforce-notes" ] } ]
        });
        const signed = tfDesktopPackagerConfig({
            TF_DESKTOP: "1", TF_DESKTOP_BUILD: "7", TF_DESKTOP_BUNDLE_ID: "invalid.example.notes",
            TF_SIGN_IDENTITY: "Developer ID Application: Example (TEAMID0000)", TF_NOTARY_PROFILE: "example-profile"
        });
        expect(signed.appBundleId).toBe("invalid.example.notes");
        expect(signed.osxSign).toMatchObject({ identity: "Developer ID Application: Example (TEAMID0000)" });
        expect(signed.osxNotarize).toEqual({ keychainProfile: "example-profile" });
        expect(() => tfDesktopPackagerConfig({ TF_DESKTOP: "1", TF_DESKTOP_BUILD: "7", TF_NOTARY_PROFILE: "p" })).toThrow();
    });

    it("takes the app and disk icons from TF_DESKTOP_ICON_DIR, and refuses a folder missing one", () => {
        const dir = mkdtempSync(path.join(tmpdir(), "tf-icons-"));
        try {
            const env = { TF_DESKTOP: "1", TF_DESKTOP_BUILD: "7", TF_DESKTOP_ICON_DIR: dir };
            mkdirSync(path.join(dir, "icon.icon"));
            writeFileSync(path.join(dir, "icon.icns"), "");
            expect(() => tfDesktopPackagerConfig(env)).toThrow(/volume\.icns/);
            writeFileSync(path.join(dir, "volume.icns"), "");
            expect(tfDesktopPackagerConfig(env).icon).toBe(path.join(dir, "icon"));
            expect(tfDesktopVolumeIcon(env)).toBe(path.join(dir, "volume.icns"));
            expect(tfDesktopVolumeIcon({ TF_DESKTOP_ICON_DIR: dir })).toBeNull();
            expect(tfDesktopPackagerConfig({ TF_DESKTOP: "1", TF_DESKTOP_BUILD: "7" }).icon).toBeUndefined();
            expect(tfDesktopVolumeIcon({ TF_DESKTOP: "1", TF_DESKTOP_BUILD: "7" })).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
