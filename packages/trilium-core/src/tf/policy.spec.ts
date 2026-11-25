import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getShareRoute, handleShareRequest, type ShareRequest } from "../share/handlers.js";
import type { ShareRoutePath } from "../share/route_paths.js";
import shareRoot from "../share/share_root.js";
import shaca from "../share/shaca/shaca.js";
import { buildShareNote } from "../test/shaca_mocking.js";
import { enableTfEmbed } from "./identity.js";
import { isTfRefusedOption, tfRawShareHeaders } from "./policy.js";

vi.mock("../becca/becca_loader.js", () => ({
    default: {
        load: vi.fn(),
        loaded: Promise.resolve()
    }
}));

describe("tf policy", () => {
    beforeEach(() => {
        shaca.reset();
        shaca.loaded = true;
    });

    afterEach(() => {
        enableTfEmbed(false);
    });

    it("refuses sync, AI and sign-in options only when embedded", () => {
        expect(isTfRefusedOption("syncServerHost")).toBe(false);
        enableTfEmbed(true);
        for (const name of [ "syncServerHost", "syncProxy", "llmProviders", "aiEnabled", "mcpEnabled", "openaiApiKey",
            "anthropicApiKey", "allowedHtmlTags", "mfaMethod", "customDbBackupDir", "backupEnableEncryption" ]) {
            expect({ name, refused: isTfRefusedOption(name) }).toEqual({ name, refused: true });
        }
        for (const name of [ "theme", "leftPaneWidth", "revisionSnapshotNumberLimit", "autoReadonlySizeText", "locale" ]) {
            expect({ name, refused: isTfRefusedOption(name) }).toEqual({ name, refused: false });
        }
    });

    it("serves raw share HTML and the view route sandboxed and as a download when embedded", () => {
        buildShareNote({
            id: shareRoot.SHARE_ROOT_NOTE_ID, title: "Shared Notes", content: "", children: [
                { id: "rawHtml", type: "code", mime: "text/html", content: "<script>parent.x()</script>", "#shareRaw": "" },
                { id: "rawText", type: "code", mime: "text/plain", content: "plain", "#shareRaw": "" }
            ]
        });

        const before = request("/share/:shareId", { shareId: "rawHtml" });
        expect(before.headers).not.toHaveProperty("Content-Disposition");
        expect(before.headers).not.toHaveProperty("Content-Security-Policy");

        enableTfEmbed(true);
        for (const reply of [ request("/share/:shareId", { shareId: "rawHtml" }), request("/share/api/notes/:noteId/view", { noteId: "rawHtml" }) ]) {
            expect(reply.headers).toMatchObject({
                "Content-Security-Policy": "sandbox; default-src 'none'",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": "attachment"
            });
        }
        const text = request("/share/:shareId", { shareId: "rawText" });
        expect(text.headers["Content-Security-Policy"]).toBe("sandbox; default-src 'none'");
        expect(text.headers).not.toHaveProperty("Content-Disposition");

        expect(tfRawShareHeaders("image/svg+xml; charset=utf-8")["Content-Disposition"]).toBe("attachment");
        expect(tfRawShareHeaders("application/atom+xml")["Content-Disposition"]).toBe("attachment");
        expect(tfRawShareHeaders("application/pdf")).not.toHaveProperty("Content-Disposition");
    });
});

function request(path: ShareRoutePath, params: Record<string, string>) {
    const req: ShareRequest = { path: `/share/${path}`, params, query: {}, getHeader: () => undefined };
    return handleShareRequest(getShareRoute(path), req);
}
