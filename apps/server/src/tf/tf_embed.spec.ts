import type { Application } from "express";
import http from "http";
import type { AddressInfo } from "net";
import supertest from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TfEvent } from "@triliumnext/core/src/tf/index.js";

const KEY = "spec-gateway-key";

interface Person {
    id: string;
    name: string;
    role: "edit" | "view";
}

const alice: Person = { id: "alice", name: "Alice Ä", role: "edit" };
const bob: Person = { id: "bob", name: "Bob", role: "edit" };
const vera: Person = { id: "vera", name: "Vera", role: "view" };

let app: Application;
let agent: ReturnType<typeof supertest.agent>;
let csrfToken: string;
let receiver: http.Server;
const received: TfEvent[] = [];
const receivedKeys = new Set<string>();

function as(person: Person | null, method: "get" | "post" | "put" | "patch" | "delete", path: string) {
    let req = agent[method](path).set("x-tf-gateway-key", KEY).set("x-csrf-token", csrfToken);
    if (person) {
        req = req
            .set("x-tf-user-id", person.id)
            .set("x-tf-user-name", encodeURIComponent(person.name))
            .set("x-tf-role", person.role);
    }
    return req;
}

async function createNote(person: Person, title: string, content = "<p>start</p>") {
    const res = await as(person, "post", "/api/notes/root/children?target=into")
        .send({ title, type: "text", content })
        .expect(200);
    return {
        noteId: res.body.note.noteId as string,
        branchId: res.body.branch.branchId as string,
        blobId: res.body.note.blobId as string
    };
}

function expectOk(res: { status: number; body: unknown }) {
    expect({ status: res.status < 300, body: res.body }).toMatchObject({ status: true });
}

async function waitForEvent(predicate: (event: TfEvent) => boolean, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const event = received.find(predicate);
        if (event) {
            return event;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Event not received in time.");
}

describe("Taskforce embedding (TF_EMBED=1)", () => {
    beforeAll(async () => {
        receiver = http.createServer((req, res) => {
            receivedKeys.add(String(req.headers["x-tf-gateway-key"]));
            let body = "";
            req.on("data", (chunk) => (body += chunk));
            req.on("end", () => {
                received.push(...(JSON.parse(body).events as TfEvent[]));
                res.writeHead(204).end();
            });
        });
        await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
        const port = (receiver.address() as AddressInfo).port;

        process.env.TF_EMBED = "1";
        process.env.TF_GATEWAY_KEY = KEY;
        process.env.TF_NOTEBOOK_ID = "abcdefghijklmnopqrst";
        process.env.TF_PARENT_ORIGINS = "https://taskforce.example, http://localhost:9700";
        process.env.TF_EVENTS_URL = `http://127.0.0.1:${port}/internal/engine-events/abcdefghijklmnopqrst`;

        app = await (await import("../app.js")).default();
        agent = supertest.agent(app);

        await agent.post("/login").set("x-tf-gateway-key", KEY).send({ password: "demo1234" }).expect(302);
        csrfToken = (await agent.get("/bootstrap").set("x-tf-gateway-key", KEY).expect(200)).body.csrfToken;
    });

    afterAll(() => {
        receiver.close();
    });

    it("refuses requests without the gateway key and keeps the health check open on loopback", async () => {
        await supertest(app).get("/api/tf/bootstrap").expect(403);
        await supertest(app).get("/api/tf/bootstrap").set("x-tf-gateway-key", "wrong").expect(403);
        await supertest(app).get("/").set("x-tf-gateway-key", `${KEY}x`).expect(403);
        await supertest(app).get("/api/health-check").expect(200);
        await supertest(app).get("/api/tf/bootstrap").set("x-tf-gateway-key", KEY).expect(200);
    });

    it("rejects a malformed user id", async () => {
        await supertest(app).get("/api/tf/bootstrap")
            .set("x-tf-gateway-key", KEY)
            .set("x-tf-user-id", "a.b")
            .expect(400);
    });

    it("answers the bootstrap with the person from the headers", async () => {
        const res = await as(alice, "get", "/api/tf/bootstrap").expect(200);
        expect(res.body).toMatchObject({
            embed: true,
            notebookId: "abcdefghijklmnopqrst",
            user: { id: "alice", name: "Alice Ä", role: "edit" },
            parentOrigins: ["https://taskforce.example", "http://localhost:9700"],
            upstreamVersion: expect.any(String),
            sourceUrl: "https://github.com/gm-worlds/trilium"
        });
        expect(res.body.engineVersion).toMatch(/\+tf\./);

        const viewer = await as(vera, "get", "/api/tf/bootstrap").expect(200);
        expect(viewer.body.user).toEqual({ id: "vera", name: "Vera", role: "view" });
    });

    it("keeps per-person options apart, including open tabs", async () => {
        const aliceTabs = JSON.stringify([{ notePath: "root", active: true }]);
        const bobTabs = JSON.stringify([{ notePath: "root/_hidden", active: true }]);

        await as(alice, "put", "/api/options").send({ openNoteContexts: aliceTabs, leftPaneWidth: "31" }).expect(204);
        await as(bob, "put", "/api/options").send({ openNoteContexts: bobTabs, theme: "next-dark" }).expect(204);

        const aliceOptions = (await as(alice, "get", "/api/options").expect(200)).body;
        const bobOptions = (await as(bob, "get", "/api/options").expect(200)).body;
        const sharedOptions = (await as(null, "get", "/api/options").expect(200)).body;

        expect(aliceOptions.openNoteContexts).toBe(aliceTabs);
        expect(aliceOptions.leftPaneWidth).toBe("31");
        expect(bobOptions.openNoteContexts).toBe(bobTabs);
        expect(bobOptions.theme).toBe("next-dark");
        expect(bobOptions.leftPaneWidth).toBe(sharedOptions.leftPaneWidth);
        expect(sharedOptions.openNoteContexts).not.toBe(aliceTabs);
        expect(sharedOptions.openNoteContexts).not.toBe(bobTabs);
        for (const options of [aliceOptions, bobOptions, sharedOptions]) {
            expect(Object.keys(options).filter((name) => name.startsWith("tfu."))).toEqual([]);
        }

        const { becca } = await import("@triliumnext/core");
        expect(becca.getOption("tfu.alice.openNoteContexts")?.value).toBe(aliceTabs);
        expect(becca.getOption("tfu.bob.theme")?.value).toBe("next-dark");
    });

    it("refuses every mutating route family for the view role, but lets a viewer keep personal options", async () => {
        const target = await createNote(alice, "Target");
        const other = await createNote(alice, "Other");
        await as(alice, "post", `/api/notes/${target.noteId}/attributes`)
            .send({ type: "label", name: "keep", value: "1" })
            .expect(204);
        const { becca } = await import("@triliumnext/core");
        const attributeId = becca.getNoteOrThrow(target.noteId).getOwnedAttribute("label", "keep")?.attributeId;
        expect(attributeId).toBeTruthy();
        const revision = await as(alice, "post", `/api/notes/${target.noteId}/revision`).send({}).expect(200);
        const gone = await createNote(alice, "Gone");
        await as(alice, "delete", `/api/notes/${gone.noteId}?taskId=t0&last=true`).expect(204);

        const attempts: [ "get" | "post" | "put" | "patch" | "delete", string, object? ][] = [
            [ "post", "/api/notes/root/children?target=into", { title: "Nope", type: "text", content: "" } ],
            [ "put", `/api/notes/${target.noteId}/data`, { content: "<p>viewer</p>" } ],
            [ "put", `/api/notes/${target.noteId}/title`, { title: "Viewer title" } ],
            [ "put", `/api/notes/${target.noteId}/type`, { type: "code", mime: "text/plain" } ],
            [ "delete", `/api/notes/${target.noteId}?taskId=t1&last=true` ],
            [ "post", `/api/notes/${target.noteId}/duplicate/root` ],
            [ "post", `/api/notes/${target.noteId}/attributes`, { type: "label", name: "x", value: "" } ],
            [ "put", `/api/notes/${target.noteId}/set-attribute`, { type: "label", name: "y", value: "1" } ],
            [ "delete", `/api/notes/${target.noteId}/attributes/${attributeId}` ],
            [ "put", `/api/branches/${target.branchId}/set-prefix`, { prefix: "p" } ],
            [ "put", `/api/branches/${other.branchId}/move-after/${target.branchId}` ],
            [ "delete", `/api/branches/${other.branchId}?taskId=t2&last=true` ],
            [ "post", `/api/notes/${target.noteId}/revision`, {} ],
            [ "delete", `/api/revisions/${revision.body.revisionId}` ],
            [ "post", `/api/notes/${target.noteId}/attachments`, { role: "file", mime: "text/plain", title: "a.txt", content: "x" } ],
            [ "put", `/api/options`, { revisionSnapshotNumberLimit: "1" } ],
            [ "put", `/api/options/revisionSnapshotNumberLimit/2` ],
            [ "put", `/api/notes/root/sort-children`, { sortBy: "title" } ],
            [ "put", `/api/notes/${target.noteId}/clone-to-note/${other.noteId}` ],
            [ "put", `/api/branches/move-to/${other.branchId}`, { branchIds: [ target.branchId ] } ],
            [ "put", `/api/branches/${target.branchId}/move-before/${other.branchId}` ],
            [ "post", `/api/delete-notes`, { branchIdsToDelete: [ target.branchId ], taskId: "t5", eraseNotes: true } ],
            [ "put", `/api/notes/${gone.noteId}/undelete`, {} ],
            [ "post", `/api/bulk-action/execute`, { noteIds: [ target.noteId ], actions: [ { name: "addLabel", labelName: "bulk", labelValue: "" } ] } ],
            [ "post", `/api/special-notes/search-note`, {} ],
            [ "get", `/api/special-notes/days/2031-02-03` ],
            [ "post", `/api/revisions/${revision.body.revisionId}/restore`, {} ],
            [ "delete", `/api/notes/${target.noteId}/revisions` ],
            [ "patch", `/api/revisions/${revision.body.revisionId}`, { description: "viewer" } ],
            [ "post", `/api/notes/erase-deleted-notes-now`, {} ],
            [ "post", `/api/notes/erase-unused-attachments-now`, {} ],
            [ "post", `/api/revisions/erase-all-excess-revisions`, {} ],
            [ "post", `/api/script/exec`, { script: "return 1", params: [], startNoteId: "root", currentNoteId: "root", originEntityName: "notes", originEntityId: "root" } ]
        ];

        for (const [ method, path, body ] of attempts) {
            const res = method === "get" ? await as(vera, method, path) : await as(vera, method, path).send(body ?? {});
            expect({ path, method, status: res.status, body: res.body }).toMatchObject({
                status: 403,
                body: { tfReadOnly: true }
            });
        }

        for (const [ field, path ] of [ [ "upload", `/api/notes/root/notes-import` ], [ "upload", `/api/notes/${target.noteId}/attachments/upload` ] ]) {
            const res = await as(vera, "post", path).attach(field, Buffer.from("hello"), "hello.txt").field("taskId", "t9").field("last", "true");
            expect({ path, status: res.status, body: res.body }).toMatchObject({ status: 403, body: { tfReadOnly: true } });
        }

        const note = becca.getNoteOrThrow(target.noteId);
        expect(note.title).toBe("Target");
        expect(note.blobId).toBe(target.blobId);
        expect(note.getOwnedLabel("bulk")).toBeFalsy();
        expect(note.getParentBranches().length).toBe(1);
        expect(note.getAttachments().length).toBe(0);
        expect(becca.getBranch(other.branchId)?.isDeleted).toBeFalsy();
        expect(becca.getNote(gone.noteId)).toBeFalsy();
        expect(becca.getRevision(revision.body.revisionId)).toBeTruthy();

        await as(vera, "put", "/api/options").send({ openNoteContexts: "[]", leftPaneVisible: "false" }).expect(204);
        expect(becca.getOption("tfu.vera.leftPaneVisible")?.value).toBe("false");
        await as(vera, "get", `/api/notes/${target.noteId}`).expect(200);
    });

    it("answers a stale save by someone else with 409 and lets the same client and a forced write through", async () => {
        const note = await createNote(alice, "Shared draft");

        const first = await as(alice, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", note.blobId)
            .set("trilium-component-id", "editor-a")
            .send({ content: "<p>alice 1</p>" })
            .expect(200);
        const aliceBlob = first.body.blobId as string;
        expect(aliceBlob).toBeTruthy();
        expect(aliceBlob).not.toBe(note.blobId);

        const conflict = await as(bob, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", note.blobId)
            .send({ content: "<p>bob from an old copy</p>" })
            .expect(409);
        expect(conflict.body).toMatchObject({
            conflict: true,
            blobId: aliceBlob,
            editedBy: { id: "alice", name: "Alice Ä" },
            editedAt: expect.any(String)
        });

        const { becca } = await import("@triliumnext/core");
        expect(becca.getNoteOrThrow(note.noteId).blobId).toBe(aliceBlob);

        await as(alice, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", note.blobId)
            .set("trilium-component-id", "editor-other")
            .send({ content: "<p>alice from another device</p>" })
            .expect(409);
        await as(alice, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", note.blobId)
            .set("trilium-component-id", "editor-a")
            .send({ content: "<p>alice 2 from the older tab</p>" })
            .expect(200);

        const revisionsBefore = becca.getNoteOrThrow(note.noteId).getRevisions().length;
        const forced = await as(bob, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", "*")
            .send({ content: "<p>bob wins</p>" })
            .expect(200);
        const saved = becca.getNoteOrThrow(note.noteId);
        expect(saved.blobId).toBe(forced.body.blobId);
        expect(saved.getContent()).toBe("<p>bob wins</p>");
        const revisions = saved.getRevisions();
        expect(revisions.length).toBe(revisionsBefore + 1);
        expect(revisions.at(-1)?.getContent()).toBe("<p>alice 2 from the older tab</p>");

        await as(bob, "put", `/api/notes/${note.noteId}/data`)
            .send({ content: "<p>no header, no guard</p>" })
            .expect(200);
    });

    it("lets the same person overwrite their own newer work only from the client that wrote it", async () => {
        const note = await createNote(alice, "Own work");
        const desk = (await as(alice, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", note.blobId).set("tf-client-id", "desk")
            .send({ content: "<p>desk 1</p>" }).expect(200)).body.blobId as string;

        // A second save of the same client still on the old base, before it saw the answer to the first.
        const desk2 = (await as(alice, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", note.blobId).set("tf-client-id", "desk")
            .send({ content: "<p>desk 2</p>" }).expect(200)).body.blobId as string;
        await as(alice, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", desk).set("tf-client-id", "desk")
            .send({ content: "<p>desk 3</p>" }).expect(200);

        // The phone opened the note before desk 1 and still has the start.
        const phone = await as(alice, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", note.blobId).set("tf-client-id", "phone")
            .send({ content: "<p>phone</p>" }).expect(409);
        expect(phone.body.editedBy).toEqual({ id: "alice", name: "Alice Ä" });
        // Without a client id there is no exemption at all.
        await as(alice, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", desk2)
            .send({ content: "<p>anonymous</p>" }).expect(409);

        // A write by the same person through another path (a to-do tick) breaks the chain.
        const { becca } = await import("@triliumnext/core");
        const beforeTick = becca.getNoteOrThrow(note.noteId).blobId;
        await as(alice, "put", `/api/notes/${note.noteId}/data`).send({ content: "<p>ticked</p>" }).expect(200);
        await as(alice, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", beforeTick as string).set("tf-client-id", "desk")
            .send({ content: "<p>desk with unsaved changes</p>" }).expect(409);
        expect(becca.getNoteOrThrow(note.noteId).getContent()).toBe("<p>ticked</p>");
    });

    it("refuses the database, SQL, sync, setup, token and AI routes for every role", async () => {
        for (const person of [ alice, vera ]) {
            for (const [ method, path ] of [
                [ "post", "/api/database/backup-database" ],
                [ "get", "/api/database/backup/download?filePath=backup-now.db" ],
                [ "get", "/api/database/backups" ],
                [ "get", "/API/Database/Backups" ],
                [ "get", "/api/%64atabase/backups" ],
                [ "get", "/api//database/backups" ],
                [ "get", "/api/x/../database/backups" ],
                [ "get", "/api%2Fdatabase/backups" ],
                [ "get", "/api/sql/schema" ],
                [ "post", "/api/sql/execute/root" ],
                [ "get", "/api/backend-log" ],
                [ "get", "/api/etapi-tokens" ],
                [ "post", "/api/etapi-tokens" ],
                [ "get", "/etapi/app-info" ],
                [ "post", "/etapi/auth/login" ],
                [ "post", "/mcp" ],
                [ "get", "/mcp" ],
                [ "post", "/api/sync/now" ],
                [ "get", "/api/sync/stats" ],
                [ "get", "/api/setup/status" ],
                [ "post", "/api/password/reset?really=yesIReallyWantToResetPasswordAndLoseAccessToMyProtectedNotes" ],
                [ "post", "/api/login/sync" ],
                [ "get", "/api/totp/status" ],
                [ "get", "/api/totp_recovery/enabled" ],
                [ "get", "/api/oauth/status" ],
                [ "get", "/api/clipper/handshake" ],
                [ "post", "/api/sender/note" ],
                [ "post", "/api/llm-chat/provider-models" ],
                [ "post", "/api/llm-chat/stream" ],
                [ "get", "/api/special-notes/recent-llm-chats" ],
                [ "get", "/api/resources" ]
            ] as const) {
                const res = await as(person, method, path).send({});
                expect({ person: person.id, method, path, status: res.status }).toEqual({ person: person.id, method, path, status: 404 });
            }
        }
        await as(vera, "post", "/api/login/protected/touch").send({}).expect((res) => expect(res.status).not.toBe(404));
    });

    it("refuses shared sync, AI, HTML and sign-in options for every role and reports AI, sync and SQL as off", async () => {
        const { becca, cls, options, sync_options } = await import("@triliumnext/core");
        const hostBefore = becca.getOption("syncServerHost")?.value;

        for (const [ name, value ] of [
            [ "syncServerHost", "https://evil.example" ], [ "syncProxy", "http://10.0.0.1:3128" ],
            [ "syncServerTimeout", "1" ], [ "llmProviders", "[]" ], [ "aiEnabled", "true" ], [ "mcpEnabled", "true" ],
            [ "openaiApiKey", "k" ], [ "anthropicApiKey", "k" ], [ "allowedHtmlTags", "[\"script\"]" ],
            [ "mfaMethod", "totp" ], [ "customDbBackupDir", "/tmp" ], [ "checkForUpdates", "true" ],
            [ "redirectBareDomain", "true" ], [ "transcriptionEnabled", "true" ], [ "dailyBackupEnabled", "false" ]
        ]) {
            await as(alice, "put", "/api/options").send({ [name]: value }).expect(403);
            await as(alice, "put", `/api/options/${name}/${encodeURIComponent(value)}`).expect(403);
        }
        // A refused option fails the whole batch, so nothing in it is written.
        await as(alice, "put", "/api/options").send({ leftPaneWidth: "44", syncServerHost: "https://evil.example" }).expect(403);
        expect(becca.getOption("tfu.alice.leftPaneWidth")?.value).not.toBe("44");
        expect(becca.getOption("syncServerHost")?.value).toBe(hostBefore);

        const reported = (await as(vera, "get", "/api/options").expect(200)).body;
        expect(reported).toMatchObject({
            aiEnabled: "false", mcpEnabled: "false", llmProviders: "[]", sqlConsoleEnabled: "false",
            backendScriptingEnabled: "false", checkForUpdates: "false", syncServerHost: "", effectiveSyncServerHost: ""
        });

        // Even a sync address already in the document starts no sync.
        cls.init(() => options.setOption("syncServerHost", "https://sync.example"));
        expect(sync_options.isSyncSetup()).toBe(false);
        cls.init(() => options.setOption("syncServerHost", ""));

        const { llmFetch } = await import("@triliumnext/core/src/services/llm/providers/fetch.js");
        await expect(llmFetch("http://127.0.0.1:9/v1/models")).rejects.toThrow("AI is off");
    });

    it("loads no #appCss note and no user-made theme with scripts off", async () => {
        const css = await createNote(alice, "Custom CSS", "body { display: none }");
        expectOk(await as(alice, "put", `/api/notes/${css.noteId}/type`).send({ type: "code", mime: "text/css" }));
        await as(alice, "post", `/api/notes/${css.noteId}/attributes`).send({ type: "label", name: "appCss", value: "" }).expect(204);
        await as(alice, "post", `/api/notes/${css.noteId}/attributes`).send({ type: "label", name: "appTheme", value: "evil" }).expect(204);
        await as(alice, "put", "/api/options").send({ theme: "evil" }).expect(204);

        const bootstrap = (await as(alice, "get", "/bootstrap").expect(200)).body;
        expect(bootstrap.tfEmbed).toBe(true);
        expect(bootstrap.appCssNoteIds).toEqual([]);
        expect(bootstrap.theme).toBe("next");
        expect(bootstrap.customThemeCssUrl).toBeUndefined();
        expect(JSON.stringify(bootstrap)).not.toContain(css.noteId);
        expect((await as(alice, "get", "/api/options/user-themes").expect(200)).body).toEqual([]);
        await as(alice, "put", "/api/options").send({ theme: "next" }).expect(204);
    });

    it("keeps tree expansion per person and never lets a viewer change the shared state", async () => {
        const folder = await createNote(alice, "Folder to open");
        const child = await as(alice, "post", `/api/notes/${folder.noteId}/children?target=into`)
            .send({ title: "Inside", type: "text", content: "" }).expect(200);
        const { becca, getSql } = await import("@triliumnext/core");
        const shared = () => getSql().getValue<number>("SELECT isExpanded FROM branches WHERE branchId = ?", [ folder.branchId ]);
        const sharedBefore = shared();
        const treeOf = async (person: Person) => {
            const tree = (await as(person, "get", "/api/tree").expect(200)).body;
            const loaded = (await as(person, "post", "/api/tree/load").send({ noteIds: [ folder.noteId ] }).expect(200)).body;
            return {
                expanded: tree.branches.find((b: { branchId: string }) => b.branchId === folder.branchId)?.isExpanded,
                loadedExpanded: loaded.branches.find((b: { branchId: string }) => b.branchId === folder.branchId)?.isExpanded,
                childLoaded: tree.notes.some((n: { noteId: string }) => n.noteId === child.body.note.noteId)
            };
        };

        await as(alice, "put", `/api/branches/${folder.branchId}/expanded/1`).expect(204);
        await as(vera, "put", `/api/branches/${folder.branchId}/expanded/1`).expect(204);
        await as(vera, "put", `/api/branches/${folder.branchId}/expanded/0`).expect(204);
        expect(shared()).toBe(sharedBefore);
        expect(becca.getBranch(folder.branchId)?.isExpanded).toBe(!!sharedBefore);

        expect(await treeOf(alice)).toEqual({ expanded: true, loadedExpanded: true, childLoaded: true });
        expect(await treeOf(bob)).toEqual({ expanded: false, loadedExpanded: false, childLoaded: false });
        expect(await treeOf(vera)).toEqual({ expanded: false, loadedExpanded: false, childLoaded: false });

        const subtree = (await as(bob, "put", `/api/branches/${folder.branchId}/expanded-subtree/1`).expect(200)).body;
        expect(subtree.branchIds).toContain(folder.branchId);
        expect((await treeOf(bob)).expanded).toBe(true);
        expect(shared()).toBe(sharedBefore);
        expect(becca.getOption("tfu.bob.tfTreeExpanded")?.value).toContain(folder.branchId);

        const options = (await as(bob, "get", "/api/options").expect(200)).body;
        expect(options.tfTreeExpanded).toBeUndefined();
    });

    it("guards block saves like note saves when the client sends a base, and refuses them for viewers", async () => {
        const blocks = `<p data-trilium-block-id="a">A</p><p data-trilium-block-id="b">B</p>`;
        const note = await createNote(alice, "Blocks", blocks);
        const { becca } = await import("@triliumnext/core");
        const { getTfLastWrite } = await import("@triliumnext/core/src/tf/index.js");
        const start = becca.getNoteOrThrow(note.noteId).blobId as string;

        const saved = await as(alice, "put", `/api/notes/${note.noteId}/blocks?block=a`)
            .set("tf-base-blob", start).set("tf-client-id", "desk")
            .send({ content: `<p data-trilium-block-id="a">A2</p>` }).expect(200);
        expect(saved.body.blobId).toBe(becca.getNoteOrThrow(note.noteId).blobId);
        expect(getTfLastWrite(note.noteId)?.by?.id).toBe("alice");

        const stale = await as(bob, "put", `/api/notes/${note.noteId}/blocks?block=b`)
            .set("tf-base-blob", start)
            .send({ content: `<p data-trilium-block-id="b">B from bob</p>` }).expect(409);
        expect(stale.body).toMatchObject({ conflict: true, editedBy: { id: "alice" } });
        await as(alice, "put", `/api/notes/${note.noteId}/blocks?block=b`)
            .set("tf-base-blob", start).set("tf-client-id", "desk")
            .send({ content: `<p data-trilium-block-id="b">B2</p>` }).expect(200);

        const viewer = await as(vera, "put", `/api/notes/${note.noteId}/blocks?block=a`)
            .send({ content: `<p data-trilium-block-id="a">viewer</p>` });
        expect({ status: viewer.status, body: viewer.body }).toMatchObject({ status: 403, body: { tfReadOnly: true } });

        // The stock client sends no base on this route; then the save goes through as before.
        await as(bob, "put", `/api/notes/${note.noteId}/blocks?block=a`)
            .send({ content: `<p data-trilium-block-id="a">A3</p>` }).expect(200);
        expect(getTfLastWrite(note.noteId)?.by?.id).toBe("bob");
        const content = String(becca.getNoteOrThrow(note.noteId).getContent());
        expect(content).toContain("A3");
        expect(content).toContain("B2");
        expect(content).not.toContain("viewer");
        expect(content).not.toContain("bob");
    });

    it("sends every content fetch through the outbound guard", async () => {
        const NodeRequestProvider = (await import("../services/request.js")).default;
        const request = new NodeRequestProvider();
        await expect(request.getImage("http://printer.local/a.png")).rejects.toThrow(/Refused to fetch/);
        await expect(request.getImage("http://0x7f.1/a.png")).rejects.toThrow(/Refused to fetch/);
        await expect(request.fetchResource("https://example.com:8443/", { maxBytes: 10 })).rejects.toThrow(/Refused to fetch/);
        const { safeFetch } = await import("../services/safe_fetch.js");
        await expect(safeFetch("http://intranet/")).rejects.toThrow(/Refused to fetch/);
    });

    it("posts change events with the person who made them", async () => {
        const note = await createNote(alice, "Evented");
        const created = await waitForEvent((e) => e.kind === "note.created" && e.noteId === note.noteId);
        expect(created).toMatchObject({ userId: "alice", userName: "Alice Ä", title: "Evented", parentNoteId: "root" });

        await as(bob, "put", `/api/notes/${note.noteId}/title`).send({ title: "Renamed" }).expect(200);
        await waitForEvent((e) => e.kind === "note.title" && e.noteId === note.noteId && e.userId === "bob");

        await as(bob, "put", `/api/notes/${note.noteId}/data`).send({ content: "<p>new</p>" }).expect(200);
        const content = await waitForEvent((e) => e.kind === "note.content" && e.noteId === note.noteId);
        expect(content.blobId).toBeTruthy();

        await as(alice, "post", `/api/notes/${note.noteId}/attributes`).send({ type: "label", name: "evented", value: "" }).expect(204);
        await waitForEvent((e) => e.kind === "attribute.changed" && e.noteId === note.noteId);

        const folder = await createNote(alice, "Folder");
        const { becca } = await import("@triliumnext/core");
        const branchId = becca.getNoteOrThrow(note.noteId).getParentBranches()[0].branchId;
        const folderBranchId = becca.getNoteOrThrow(folder.noteId).getParentBranches()[0].branchId;
        await as(alice, "put", `/api/branches/move-to/${folderBranchId}`).send({ branchIds: [ branchId ] }).expect(200);
        const moved = await waitForEvent((e) => e.kind === "note.moved" && e.noteId === note.noteId);
        expect(moved.parentNoteId).toBe(folder.noteId);

        await as(alice, "post", `/api/notes/${note.noteId}/revision`).send({}).expect(200);
        await waitForEvent((e) => e.kind === "revision.created" && e.noteId === note.noteId && !!e.revisionId);

        await as(alice, "delete", `/api/notes/${note.noteId}?taskId=t3&last=true`).expect(204);
        await waitForEvent((e) => e.kind === "note.deleted" && e.noteId === note.noteId);

        await as(alice, "put", `/api/notes/${note.noteId}/undelete`).send({}).expect(200);
        await waitForEvent((e) => e.kind === "note.restored" && e.noteId === note.noteId && e.userId === "alice");

        expect(received.some((e) => e.noteId.startsWith("_"))).toBe(false);
        expect([ ...receivedKeys ]).toEqual([ KEY ]);
    });

    it("records who unlocked protected notes", async () => {
        await as(alice, "get", "/api/tf/protected").expect(200, { unlocked: false, by: null });

        await as(alice, "post", "/api/login/protected").send({ password: "demo1234" }).expect(200);
        await waitForEvent((e) => e.kind === "protected.unlocked" && e.userId === "alice");
        await as(bob, "get", "/api/tf/protected").expect(200, { unlocked: true, by: { id: "alice", name: "Alice Ä" } });

        await as(bob, "post", "/api/logout/protected").send({}).expect(204);
        await waitForEvent((e) => e.kind === "protected.locked" && e.userId === "bob");
        await as(alice, "get", "/api/tf/protected").expect(200, { unlocked: false, by: null });
    });

    it("lets an editor change the protected-notes password, and nobody reset it", async () => {
        await as(vera, "post", "/api/password/change").send({ current_password: "demo1234", new_password: "x" })
            .expect(403).expect((res) => expect(res.body.tfReadOnly).toBe(true));
        await as(alice, "post", "/api/password/reset?really=yesIReallyWantToResetPasswordAndLoseAccessToMyProtectedNotes").send({}).expect(404);
        await as(alice, "post", "/api/password/set").send({}).expect(404);

        const wrong = await as(alice, "post", "/api/password/change").send({ current_password: "nope", new_password: "x" }).expect(200);
        expect(wrong.body.success).toBe(false);

        const changed = await as(alice, "post", "/api/password/change").send({ current_password: "demo1234", new_password: "demo1234" }).expect(200);
        expect(changed.body.success).toBe(true);

        // A password change ends every session (upstream); sign in again and open the protected session.
        await agent.post("/login").set("x-tf-gateway-key", KEY).send({ password: "demo1234" }).expect(302);
        csrfToken = (await agent.get("/bootstrap").set("x-tf-gateway-key", KEY).expect(200)).body.csrfToken;
        const unlocked = await as(alice, "post", "/api/login/protected").send({ password: "demo1234" }).expect(200);
        expect(unlocked.body.success).toBe(true);
    });
});
