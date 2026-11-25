import { describe, expect, it } from "vitest";

import { canonicalTfPath, decideTfRoute } from "./route_policy.js";

describe("tf route policy", () => {
    it("builds the canonical path and refuses malformed ones", () => {
        expect(canonicalTfPath("/")).toBe("/");
        expect(canonicalTfPath("/API/Database/Backups/?x=1")).toBe("/api/database/backups");
        expect(canonicalTfPath("/api/%64atabase/backups")).toBe("/api/database/backups");
        expect(canonicalTfPath("/api/images/n1/a%2Fb.png")).toBe("/api/images/n1/a/b.png");
        for (const bad of [
            "/api//database/backups", "/api/./database", "/api/x/../database", "/api/%2e%2e/database",
            "/api%2fdatabase/backups", "/api%5Cdatabase/backups", "/api\\database", "/api/%zz", "/api/a%00",
            "/api/images/n1/..", "/api/x//", "http://host/api/database"
        ]) {
            expect({ bad, path: canonicalTfPath(bad) }).toEqual({ bad, path: null });
        }
    });

    it("refuses the admin, sync, AI and API-token routes for every role, however they are spelled", () => {
        const refused = [
            "/api/database/backup-database", "/api/database/backup/download?filePath=/x", "/api/database/backups",
            "/API/DATABASE/backups", "/api/database/backups/", "/api/%64atabase/backups", "/api/database%2Fbackups",
            "/api/sql/execute/n1", "/api/sql/schema", "/api/backend-log", "/api/etapi-tokens", "/api/etapi-tokens/t1",
            "/etapi/notes/root", "/ETAPI/backup/x", "/etapi%2Fnotes", "/mcp", "/mcp/", "/api/sync/now",
            "/api/setup/sync-from-server", "/api/password/reset", "/api/login/sync", "/api/login/token", "/api/totp/status",
            "/api/totp_recovery/enabled", "/api/oauth/status", "/api/clipper/handshake", "/api/sender/note",
            "/api/llm-chat/stream", "/api/llm-chat/provider-models", "/api/special-notes/recent-llm-chats",
            "/api/special-notes/llm-chat", "/api/resources", "/api/onenote-import/status", "/api/network-addresses",
            "/api/metrics", "/api/backup", "/api//database/backups", "/api/./database/backups"
        ];
        for (const url of refused) {
            for (const role of [ "edit", "view", null ] as const) {
                expect({ url, role, decision: decideTfRoute(url, role) }).toEqual({ url, role, decision: "refuse" });
            }
        }

        const allowed = [
            "/", "/api/login/protected", "/api/login/protected/touch", "/api/logout/protected", "/api/notes/root",
            "/api/options", "/share/abc", "/share/api/notes/abc/view", "/api/special-notes/days/2026-01-01",
            "/api/images/n1/a%2Fb.png", "/api/attribute-names/", "/api/tf/bootstrap", "/bootstrap", "/api/system-checks"
        ];
        for (const url of allowed) {
            expect({ url, decision: decideTfRoute(url, "edit") }).toEqual({ url, decision: "allow" });
        }
    });

    it("lets only the gateway itself, without a person, ask for and make a new notebook's document", () => {
        for (const url of [ "/api/setup/status", "/api/setup/new-document?skipDemoDb", "/API/Setup/Status/" ]) {
            expect({ url, decision: decideTfRoute(url, null) }).toEqual({ url, decision: "allow" });
            for (const role of [ "edit", "view" ] as const) {
                expect({ url, role, decision: decideTfRoute(url, role) }).toEqual({ url, role, decision: "refuse" });
            }
        }
        // Nothing else of the setup family, not even for the gateway.
        expect(decideTfRoute("/api/setup/sync-from-server", null)).toBe("refuse");
        expect(decideTfRoute("/api/setup/new-document/x", null)).toBe("refuse");
    });

    it("refuses script, erase and import routes for a viewer only", () => {
        for (const url of [
            "/api/script/exec", "/api/script/run/n1", "/api/search-and-execute-note/n1",
            "/api/notes/erase-deleted-notes-now", "/api/notes/erase-unused-attachments-now",
            "/api/revisions/erase-all-excess-revisions", "/api/notes/root/notes-import",
            "/api/notes/n1/attachments-import", "/api/notes/n1/attachments/upload", "/API/Script/Exec",
            "/api/bulk-action/execute"
        ]) {
            expect({ url, view: decideTfRoute(url, "view"), edit: decideTfRoute(url, "edit") })
                .toEqual({ url, view: "read-only", edit: "allow" });
        }
        expect(decideTfRoute("/api/notes/n1/attachments", "view")).toBe("allow");
        expect(decideTfRoute("/api/bulk-action/affected-notes", "view")).toBe("allow");
    });

    it("opens only the password change route, for editors", () => {
        expect(decideTfRoute("/api/password/change", "edit")).toBe("allow");
        expect(decideTfRoute("/API/Password/Change/", "edit")).toBe("allow");
        expect(decideTfRoute("/api/password/change", null)).toBe("allow");
        expect(decideTfRoute("/api/password/change", "view")).toBe("read-only");
        for (const url of [ "/api/password/reset", "/api/password/reset?really=yes", "/api/password", "/api/password/change/x", "/api/password//change" ]) {
            for (const role of [ "edit", "view" ] as const) {
                expect({ url, role, decision: decideTfRoute(url, role) }).toEqual({ url, role, decision: "refuse" });
            }
        }
    });
    it("opens exactly the sync protocol on the sync channel, and only for an editor", () => {
        const sync = [
            "/api/login/sync", "/api/sync/check", "/api/sync/changed?instanceId=a&lastEntityChangeId=0",
            "/api/sync/update?logMarkerId=x", "/api/sync/finished", "/api/sync/check-entity-changes",
            "/api/sync/queue-sector/notes/a1", "/API/Sync/Changed/"
        ];
        for (const url of sync) {
            expect({ url, decision: decideTfRoute(url, "edit", "sync") }).toEqual({ url, decision: "allow" });
            expect({ url, decision: decideTfRoute(url, "view", "sync") }).toEqual({ url, decision: "refuse" });
            expect({ url, decision: decideTfRoute(url, null, "sync") }).toEqual({ url, decision: "refuse" });
            expect({ url, decision: decideTfRoute(url, "edit") }).toEqual({ url, decision: "refuse" });
        }
        for (const url of [
            "/", "/api/notes/root", "/api/options", "/api/sync/now", "/api/sync/force-full-sync",
            "/api/sync/fill-entity-changes", "/api/sync/stats", "/api/setup/sync-seed", "/api/setup/status",
            "/api/sync/queue-sector/notes", "/api/sync/queue-sector/notes/a/b", "/api/sync//changed",
            "/api/login/protected", "/etapi/notes/root", "/api/sql/execute/x"
        ]) {
            expect({ url, decision: decideTfRoute(url, "edit", "sync") }).toEqual({ url, decision: "refuse" });
        }
    });
});
