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

        const attempts: [ "post" | "put" | "patch" | "delete", string, object? ][] = [
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
            [ "put", `/api/notes/root/sort-children`, { sortBy: "title" } ]
        ];

        for (const [ method, path, body ] of attempts) {
            const res = await as(vera, method, path).send(body ?? {});
            expect({ path, method, status: res.status, body: res.body }).toMatchObject({
                status: 403,
                body: { tfReadOnly: true }
            });
        }

        const note = becca.getNoteOrThrow(target.noteId);
        expect(note.title).toBe("Target");
        expect(note.blobId).toBe(target.blobId);
        expect(becca.getBranch(other.branchId)?.isDeleted).toBeFalsy();

        await as(vera, "put", "/api/options").send({ openNoteContexts: "[]", leftPaneVisible: "false" }).expect(204);
        expect(becca.getOption("tfu.vera.leftPaneVisible")?.value).toBe("false");
        await as(vera, "get", `/api/notes/${target.noteId}`).expect(200);
    });

    it("answers a stale save by someone else with 409 and lets the same writer and a forced write through", async () => {
        const note = await createNote(alice, "Shared draft");

        const first = await as(alice, "put", `/api/notes/${note.noteId}/data`)
            .set("tf-base-blob", note.blobId)
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
});
