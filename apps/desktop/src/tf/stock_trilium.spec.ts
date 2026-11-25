import Database from "better-sqlite3";
import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { copyStockTriliumDb, isStockTriliumInPsOutput, removeTempCopy, stockTriliumDbPath } from "./stock_trilium";

const dirs: string[] = [];
const tempDir = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-stock-"));
    dirs.push(dir);
    return dir;
};
const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("stock Trilium on this Mac", () => {
    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("looks where the stock app keeps its notes", () => {
        const home = "/home-example/person";
        expect(stockTriliumDbPath({ homedir: home, platform: "darwin", homeDataDirExists: false }))
            .toBe(`${home}/Library/Application Support/trilium-data/document.db`);
        expect(stockTriliumDbPath({ homedir: home, platform: "darwin", homeDataDirExists: true })).toBe(`${home}/trilium-data/document.db`);
        expect(stockTriliumDbPath({ homedir: home, platform: "darwin", homeDataDirExists: true, testDir: "/tmp/x" })).toBe("/tmp/x/document.db");
    });

    it("recognises a running stock Trilium, not this app", () => {
        const ps = [
            "  101 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
            "  202 /Applications/Taskforce Notes.app/Contents/MacOS/taskforce-notes",
            "  203 /Applications/Taskforce Notes.app/Contents/Frameworks/Taskforce Notes Helper.app/Contents/MacOS/Taskforce Notes Helper"
        ].join("\n");
        expect(isStockTriliumInPsOutput(ps, 202, "/Applications/Taskforce Notes.app/Contents/MacOS/taskforce-notes")).toBe(false);
        expect(isStockTriliumInPsOutput(`${ps}\n  303 /Applications/Trilium Notes.app/Contents/MacOS/trilium`, 202, "x")).toBe(true);
        expect(isStockTriliumInPsOutput("  404 /Applications/Trilium Notes.app/Contents/Frameworks/Trilium Notes Helper (Renderer).app/Contents/MacOS/Trilium Notes Helper (Renderer)", 1, "x")).toBe(true);
        expect(isStockTriliumInPsOutput("  505 /usr/bin/trilium", 1, "x")).toBe(true);
    });

    it("copies the notes, a pending WAL included, without touching the stock folder", async () => {
        const stock = tempDir();
        const source = path.join(stock, "document.db");
        const db = new Database(source);
        db.pragma("journal_mode = WAL");
        db.pragma("wal_autocheckpoint = 0");
        db.exec("CREATE TABLE notes (noteId TEXT PRIMARY KEY, title TEXT, isDeleted INT NOT NULL DEFAULT 0)");
        db.prepare("INSERT INTO notes (noteId, title) VALUES (?, ?)").run("a", "first");
        db.close();
        // A second write left in the WAL, as after a crash: the connection is never closed cleanly.
        const crashed = new Database(source);
        crashed.pragma("wal_autocheckpoint = 0");
        crashed.prepare("INSERT INTO notes (noteId, title) VALUES (?, ?)").run("b", "in the wal");
        crashed.prepare("INSERT INTO notes (noteId, title, isDeleted) VALUES (?, ?, 1)").run("c", "deleted");
        const before = Object.fromEntries(fs.readdirSync(stock).map((file) => [ file, hash(path.join(stock, file)) ]));
        expect(Object.keys(before).sort()).toEqual([ "document.db", "document.db-shm", "document.db-wal" ]);

        const target = path.join(tempDir(), "copy.db");
        const progress: number[] = [];
        const result = await copyStockTriliumDb(source, target, (done) => progress.push(done));

        expect(result.notes).toBe(2);
        expect(result.sizeBytes).toBe(fs.statSync(target).size);
        expect(progress.length).toBeGreaterThan(0);
        const after = Object.fromEntries(fs.readdirSync(stock).map((file) => [ file, hash(path.join(stock, file)) ]));
        expect(after).toEqual(before);
        expect(fs.readdirSync(path.dirname(target))).toEqual([ "copy.db" ]);
        const copy = new Database(target, { readonly: true });
        expect(copy.pragma("journal_mode", { simple: true })).toBe("delete");
        copy.close();
        crashed.close();

        removeTempCopy(target);
        expect(fs.existsSync(target)).toBe(false);
    });
});
