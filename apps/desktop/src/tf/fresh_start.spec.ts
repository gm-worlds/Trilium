import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { runFreshStartIfAsked, takePendingConnect, writeFreshStartMarker } from "./fresh_start";

let dir = "";

describe("fresh start for another notebook", () => {
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("moves the database files into backup/ and keeps the link for the connect screen", () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-fresh-"));
        for (const file of [ "document.db", "document.db-wal" ]) {
            fs.writeFileSync(path.join(dir, file), file);
        }
        expect(runFreshStartIfAsked(dir)).toBeNull();
        expect(fs.existsSync(path.join(dir, "document.db"))).toBe(true);

        writeFreshStartMarker(dir, { link: "taskforce-notes://connect?x" }, "Old / notebook");
        const backup = runFreshStartIfAsked(dir, new Date("2026-11-25T10:00:00Z"));
        expect(backup).toBe(path.join(dir, "backup", "before-connecting Old  notebook 2026-11-25T10-00-00-000Z.db"));
        expect(fs.readdirSync(path.join(dir, "backup")).sort()).toEqual([
            "before-connecting Old  notebook 2026-11-25T10-00-00-000Z.db",
            "before-connecting Old  notebook 2026-11-25T10-00-00-000Z.db-wal"
        ]);
        expect(fs.existsSync(path.join(dir, "document.db"))).toBe(false);
        expect(runFreshStartIfAsked(dir)).toBeNull();

        expect(takePendingConnect(dir)).toEqual({ link: "taskforce-notes://connect?x", redeemed: undefined });
        expect(takePendingConnect(dir)).toEqual({});
    });
});
