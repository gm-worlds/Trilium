import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

const TSX = path.resolve(__dirname, "../../../../node_modules/.bin/tsx");
const DATA_DIR_MODULE = path.resolve(__dirname, "../services/data_dir.ts");
const PORT_MODULE = path.resolve(__dirname, "../services/port.ts");

/** Imports `data_dir.ts` and `port.ts` in a fresh process, the way the app's first import does. */
function resolveIn(env: Record<string, string>) {
    const script = "(async () => {"
        + `const dm = await import(${JSON.stringify(DATA_DIR_MODULE)}); const d = dm.default?.default ?? dm.default;`
        + `const pm = await import(${JSON.stringify(PORT_MODULE)}); const p = pm.default?.default ?? pm.default;`
        + "console.log(JSON.stringify({ dataDir: d.TRILIUM_DATA_DIR, document: d.DOCUMENT_PATH, port: p, electron: process.env.TRILIUM_ELECTRON_DATA_DIR }));"
        + "process.exit(0);"
        + "})().catch((e) => { console.error(e); process.exit(1); });";
    const output = execFileSync(TSX, [ "--eval", script ], {
        env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), TRILIUM_ENV: "dev", ...env },
        encoding: "utf-8",
        timeout: 45_000
    });
    return JSON.parse(output.trim().split("\n").at(-1) ?? "{}");
}

describe("Taskforce Notes data folder", () => {
    it("is claimed by data_dir.ts itself, whatever the environment says", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tf-env-"));
        try {
            const tfDir = path.join(root, "Taskforce Notes");
            const stockDir = path.join(root, "trilium-data");
            fs.mkdirSync(stockDir);

            const claimed = resolveIn({
                TF_DESKTOP: "1",
                TF_NOTES_DATA_DIR: tfDir,
                TRILIUM_DATA_DIR: stockDir,
                TRILIUM_DOCUMENT_PATH: path.join(stockDir, "document.db"),
                TRILIUM_PORT: "37840"
            });
            expect(claimed).toEqual({
                dataDir: tfDir,
                document: path.join(tfDir, "document.db"),
                port: 37851,
                electron: path.join(tfDir, "electron-profile")
            });

            expect(() => resolveIn({ TF_DESKTOP: "1", TF_NOTES_DATA_DIR: stockDir })).toThrow();

            const upstream = resolveIn({ TRILIUM_DATA_DIR: stockDir, TRILIUM_PORT: "37840" });
            expect(upstream.dataDir).toBe(stockDir);
            expect(upstream.port).toBe(37840);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }, 60_000);
});
