import { afterEach, describe, expect, it, vi } from "vitest";

import { installLinkCapture, installShortcutCapture, matchesShortcut } from "./capture.js";
import { getCapabilities, isAllowedOrigin, registerCapability, TfBridge } from "./bridge.js";

const HOST = "https://taskforce.example";

type Listener = (event: MessageEvent) => void;

function fakeWindows() {
    const posted: { message: unknown; origin: string }[] = [];
    const parent = {
        postMessage: (message: unknown, origin: string) => posted.push({ message, origin })
    } as unknown as Window;
    const listeners = new Set<Listener>();
    const self = {
        addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener)
    } as unknown as Window;
    const deliver = (event: Partial<MessageEvent>) => {
        for (const listener of [ ...listeners ]) {
            listener(event as MessageEvent);
        }
    };
    return { parent, self, posted, deliver, listeners };
}

function nextMessage(port: MessagePort): Promise<any> {
    return new Promise((resolve) => {
        port.onmessage = (event) => resolve(event.data);
    });
}

const bridges: TfBridge[] = [];
const ports: MessagePort[] = [];

afterEach(() => {
    for (const bridge of bridges.splice(0)) {
        bridge.dispose();
    }
    for (const port of ports.splice(0)) {
        port.close();
    }
});

function makeBridge() {
    const windows = fakeWindows();
    const bridge = new TfBridge({
        notebookId: "nb1",
        parentOrigins: [ HOST, "http://localhost:9700" ],
        parent: windows.parent,
        self: windows.self,
        helloIntervalMs: 5,
        maxHelloAttempts: 3
    });
    bridges.push(bridge);
    return { bridge, ...windows };
}

describe("TfBridge", () => {
    it("says hello to each parent origin and retries until the host answers", async () => {
        const { bridge, posted } = makeBridge();
        void bridge.connect();
        await new Promise((resolve) => setTimeout(resolve, 30));

        expect(posted.slice(0, 2)).toEqual([
            { message: { type: "tf-notes:hello", protocol: 1, notebookId: "nb1" }, origin: HOST },
            { message: { type: "tf-notes:hello", protocol: 1, notebookId: "nb1" }, origin: "http://localhost:9700" }
        ]);
        expect(posted).toHaveLength(6);
    });

    it("accepts the port only from an allowed origin and the parent window", async () => {
        const { bridge, parent, deliver } = makeBridge();
        const connected = bridge.connect();

        const evil = new MessageChannel();
        ports.push(evil.port1, evil.port2);
        deliver({ origin: "https://evil.example", source: parent, data: { type: "tf-notes:port" }, ports: [ evil.port2 ] });
        deliver({ origin: HOST, source: {} as Window, data: { type: "tf-notes:port" }, ports: [ evil.port2 ] });
        deliver({ origin: HOST, source: parent, data: { type: "something-else" }, ports: [ evil.port2 ] });
        expect(bridge.connected).toBe(false);

        bridge.notify("ready", { engineVersion: "x", capabilities: getCapabilities() });

        const channel = new MessageChannel();
        ports.push(channel.port1, channel.port2);
        const firstMessage = nextMessage(channel.port1);
        deliver({ origin: HOST, source: parent, data: { type: "tf-notes:port" }, ports: [ channel.port2 ] });
        await connected;
        expect(bridge.connected).toBe(true);
        expect(await firstMessage).toEqual({ method: "ready", params: { engineVersion: "x", capabilities: [ "tf-bridge-1" ] } });
    });

    it("answers host requests and resolves its own requests", async () => {
        const { bridge, parent, deliver } = makeBridge();
        const connected = bridge.connect();
        const channel = new MessageChannel();
        ports.push(channel.port1, channel.port2);
        deliver({ origin: HOST, source: parent, data: { type: "tf-notes:port" }, ports: [ channel.port2 ] });
        await connected;

        const init = vi.fn(() => ({ ok: true }));
        bridge.on("init", init);
        let reply = nextMessage(channel.port1);
        channel.port1.postMessage({ id: "h1", method: "init", params: { tabName: "Notes" } });
        expect(await reply).toEqual({ id: "h1", result: { ok: true } });
        expect(init).toHaveBeenCalledWith({ tabName: "Notes" });

        reply = nextMessage(channel.port1);
        channel.port1.postMessage({ id: "h2", method: "capture", params: {} });
        expect(await reply).toMatchObject({ id: "h2", error: { code: "unsupported" } });

        bridge.on("goto", () => {
            throw new Error("no such note");
        });
        reply = nextMessage(channel.port1);
        channel.port1.postMessage({ id: "h3", method: "goto", params: { noteId: "x" } });
        expect(await reply).toEqual({ id: "h3", error: { code: "failed", message: "no such note" } });

        const sent = nextMessage(channel.port1);
        const result = bridge.request("task.create", { title: "T", noteId: "n" });
        const request = await sent;
        expect(request).toMatchObject({ method: "task.create", params: { title: "T", noteId: "n" } });
        channel.port1.postMessage({ id: request.id, result: { taskId: "t1" } });
        await expect(result).resolves.toEqual({ taskId: "t1" });
    });

    it("lists registered capabilities and checks origins strictly", () => {
        registerCapability("tf-test-1");
        expect(getCapabilities()).toContain("tf-test-1");
        expect(isAllowedOrigin(HOST, [ HOST ])).toBe(true);
        expect(isAllowedOrigin(`${HOST}.evil`, [ HOST ])).toBe(false);
        expect(isAllowedOrigin("null", [ "null" ])).toBe(false);
    });
});

describe("tf input capture", () => {
    it("sends Taskforce links to the host instead of navigating", () => {
        const open = vi.fn();
        const dispose = installLinkCapture([ HOST ], open);
        try {
            const inside = document.createElement("a");
            inside.href = `${HOST}/tasks/42`;
            const outside = document.createElement("a");
            outside.href = "https://example.org/";
            const lookalike = document.createElement("a");
            lookalike.href = `${HOST}.evil.example/x`;
            document.body.append(inside, outside, lookalike);

            const insideEvent = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
            inside.dispatchEvent(insideEvent);
            outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
            lookalike.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));

            expect(open).toHaveBeenCalledTimes(1);
            expect(open).toHaveBeenCalledWith(`${HOST}/tasks/42`);
            expect(insideEvent.defaultPrevented).toBe(true);
        } finally {
            dispose();
            document.body.replaceChildren();
        }
    });

    it("forwards only the host's shortcuts", () => {
        const forward = vi.fn();
        const dispose = installShortcutCapture(() => [ { key: "k", meta: true } ], forward);
        try {
            const hostKey = new KeyboardEvent("keydown", { key: "K", metaKey: true, cancelable: true, bubbles: true });
            window.dispatchEvent(hostKey);
            window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));

            expect(forward).toHaveBeenCalledTimes(1);
            expect(forward).toHaveBeenCalledWith({ key: "k", meta: true, ctrl: false, shift: false, alt: false });
            expect(hostKey.defaultPrevented).toBe(true);
            expect(matchesShortcut(new KeyboardEvent("keydown", { key: "p", shiftKey: true }), { key: "p" })).toBe(false);
        } finally {
            dispose();
        }
    });
});
