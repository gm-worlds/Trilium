import { afterAll, beforeAll, describe, expect, it } from "vitest";

import becca from "../becca/becca.js";
import optionsRoute from "../routes/api/options.js";
import scriptRoute from "../routes/api/script.js";
import config from "../services/config.js";
import { getContext } from "../services/context.js";
import options from "../services/options.js";
import { isScriptingEnabled } from "../services/scripting_guard.js";
import { assertTfWritable, TfReadOnlyError } from "./guard.js";
import { enableTfEmbed, getTfUser, isTfScriptsOff, parseTfIdentityHeaders, setTfScriptsOff, setTfUser, type TfUser } from "./identity.js";
import { applyTfOptionOverlay, isTfOwnOption, isTfPerUserOption, resolveTfOptionRead } from "./options.js";

const alice: TfUser = { id: "alice", name: "Alice", role: "edit" };
const vera: TfUser = { id: "vera", name: "Vera", role: "view" };

function asUser<T>(user: TfUser | null, fn: () => T): T {
    return getContext().init(() => {
        setTfUser(user);
        return fn();
    });
}

describe("tf core", () => {
    beforeAll(() => {
        enableTfEmbed(true);
    });

    afterAll(() => {
        enableTfEmbed(false);
    });

    it("parses the gateway's identity headers", () => {
        expect(parseTfIdentityHeaders({})).toBeNull();
        expect(parseTfIdentityHeaders({ "x-tf-user-id": "u1", "x-tf-user-name": "Ren%C3%A9e", "x-tf-role": "edit" }))
            .toEqual({ id: "u1", name: "Renée", role: "edit" });
        expect(parseTfIdentityHeaders({ "x-tf-user-id": "u2" })).toEqual({ id: "u2", name: "u2", role: "view" });
        expect(() => parseTfIdentityHeaders({ "x-tf-user-id": "tfu.x" })).toThrow();
        expect(asUser(alice, () => getTfUser())).toEqual(alice);
    });

    it("reads and writes per-person options under tfu.<id>.<name> with a shared fallback", () => {
        const shared = options.getOption("leftPaneWidth");

        asUser(alice, () => {
            expect(options.getOption("leftPaneWidth")).toBe(shared);
            options.setOption("leftPaneWidth", "42");
            expect(options.getOption("leftPaneWidth")).toBe("42");
            expect(resolveTfOptionRead("leftPaneWidth")).toBe("tfu.alice.leftPaneWidth");
            expect(options.getOptionMap().leftPaneWidth).toBe("42");
        });

        expect(becca.getOption("tfu.alice.leftPaneWidth")?.value).toBe("42");
        expect(asUser(null, () => options.getOption("leftPaneWidth"))).toBe(shared);
        expect(asUser(vera, () => options.getOptionMap().leftPaneWidth)).toBe(shared);
        expect(Object.keys(asUser(vera, () => options.getOptionMap())).some((name) => name.startsWith("tfu."))).toBe(false);

        expect(isTfPerUserOption("revisionSnapshotNumberLimit")).toBe(false);
        expect(isTfPerUserOption("someSectionCollapsed")).toBe(true);
    });

    it("lets the overlay drop other people's options and keep the person's own", () => {
        const map = {
            theme: "next",
            "tfu.alice.theme": "next-dark",
            "tfu.bob.theme": "next-light",
            "tfu.alice.passwordVerificationHash": "x"
        };
        expect(asUser(alice, () => applyTfOptionOverlay(map))).toEqual({ theme: "next-dark" });
        expect(asUser(null, () => applyTfOptionOverlay(map))).toEqual({ theme: "next" });
    });

    it("refuses writes for the view role except the viewer's own options and recent notes", () => {
        asUser(vera, () => {
            expect(() => assertTfWritable("notes", "n1")).toThrow(TfReadOnlyError);
            expect(() => assertTfWritable("options", "theme")).toThrow(TfReadOnlyError);
            expect(() => assertTfWritable("options", "tfu.alice.theme")).toThrow(TfReadOnlyError);
            expect(() => assertTfWritable("options", "tfu.vera.theme")).not.toThrow();
            expect(() => assertTfWritable("recent_notes", "r1")).not.toThrow();
        });
        asUser(alice, () => expect(() => assertTfWritable("notes", "n1")).not.toThrow());
        asUser(null, () => expect(() => assertTfWritable("notes", "n1")).not.toThrow());

        enableTfEmbed(false);
        try {
            asUser(vera, () => expect(() => assertTfWritable("notes", "n1")).not.toThrow());
        } finally {
            enableTfEmbed(true);
        }
    });

    it("turns notebook scripts off without safe mode: empty script lists, no backend scripts", () => {
        const scriptingConfigured = config.Security.backendScriptingEnabled;
        config.Security.backendScriptingEnabled = true;
        try {
            setTfScriptsOff(true);
            expect(isTfScriptsOff()).toBe(true);
            expect(isScriptingEnabled()).toBe(false);
            expect(asUser(alice, () => scriptRoute.getWidgetBundles())).toEqual([]);
            expect(asUser(alice, () => scriptRoute.getStartupBundles({ query: {} } as never))).toEqual([]);
            expect(asUser(alice, () => scriptRoute.getBundle({ params: { noteId: "root" }, body: {} } as never))).toBeNull();

            setTfScriptsOff(false);
            expect(isScriptingEnabled()).toBe(true);

            setTfScriptsOff(true);
            enableTfEmbed(false);
            expect(isTfScriptsOff()).toBe(false);
            expect(isScriptingEnabled()).toBe(true);
        } finally {
            enableTfEmbed(true);
            setTfScriptsOff(false);
            config.Security.backendScriptingEnabled = scriptingConfigured;
        }
    });

    it("reports backend scripting off with TF_SCRIPTS=off and the SQL console off whenever embedded", () => {
        const { backendScriptingEnabled, sqlConsoleEnabled } = config.Security;
        config.Security.backendScriptingEnabled = true;
        config.Security.sqlConsoleEnabled = true;
        try {
            setTfScriptsOff(true);
            expect(asUser(alice, () => optionsRoute.getOptions())).toMatchObject({ backendScriptingEnabled: "false", sqlConsoleEnabled: "false" });
            setTfScriptsOff(false);
            expect(asUser(alice, () => optionsRoute.getOptions())).toMatchObject({ backendScriptingEnabled: "true", sqlConsoleEnabled: "false" });
            enableTfEmbed(false);
            expect(asUser(null, () => optionsRoute.getOptions())).toMatchObject({ backendScriptingEnabled: "true", sqlConsoleEnabled: "true" });
        } finally {
            enableTfEmbed(true);
            setTfScriptsOff(false);
            config.Security.backendScriptingEnabled = backendScriptingEnabled;
            config.Security.sqlConsoleEnabled = sqlConsoleEnabled;
        }
    });

    it("serves the embedding's own options per person, and only while embedded", () => {
        asUser(alice, () => {
            options.setOption("tfTextScale" as never, "1.4");
            expect(isTfOwnOption("tfTextScale")).toBe(true);
            expect(optionsRoute.getOptions()).toMatchObject({ tfTextScale: "1.4" });
        });
        expect(becca.getOption("tfu.alice.tfTextScale")?.value).toBe("1.4");
        expect(isTfOwnOption("revisionSnapshotNumberLimit")).toBe(false);

        enableTfEmbed(false);
        try {
            expect(isTfOwnOption("tfTextScale")).toBe(false);
        } finally {
            enableTfEmbed(true);
        }
    });
});
