import { EventEmitter } from "events";
import { describe, expect, it, vi } from "vitest";

/** A stand-in for `electron.net`: records the request options and answers with `reply`. */
const recorded: { headers?: Record<string, unknown>; url?: string }[] = [];
let reply = { status: 200, body: "{}" };

const net = {
    request(options: { headers?: Record<string, unknown>; url?: string }) {
        recorded.push(options);
        const request = new EventEmitter() as EventEmitter & { end: (payload?: string) => void };
        request.end = () => {
            const response = new EventEmitter() as EventEmitter & { statusCode: number; statusMessage: string; headers: Record<string, string> };
            response.statusCode = reply.status;
            response.statusMessage = reply.status === 401 ? "Unauthorized" : "OK";
            response.headers = {};
            queueMicrotask(() => {
                request.emit("response", response);
                response.emit("data", Buffer.from(reply.body));
                response.emit("end");
            });
        };
        return request;
    }
};

vi.mock("electron", () => ({ default: { net, app: { isReady: () => true, whenReady: () => Promise.resolve() } } }));
vi.mock("@triliumnext/server/src/services/resources.js", () => ({ default: { setFetch: vi.fn() } }));

const { default: ElectronRequestProvider } = await import("../services/request.js");
const { classifyTfSyncError } = await import("@triliumnext/core/src/tf/desktop.js");

describe("device key on the Electron net path", () => {
    const provider = new ElectronRequestProvider();

    it("passes the extra headers next to Trilium's own", async () => {
        reply = { status: 200, body: "{\"ok\":true}" };
        await expect(provider.exec({
            method: "POST", url: "https://nb-example.invalid/api/login/sync", proxy: null, timeout: 1000,
            body: { a: 1 }, headers: { "x-tf-device": "dev_token" }
        })).resolves.toEqual({ ok: true });
        expect(recorded.at(-1)?.headers).toMatchObject({ "x-tf-device": "dev_token", "Content-Type": "application/json" });

        await provider.exec({ method: "GET", url: "https://nb-example.invalid/api/sync/check", proxy: null, timeout: 1000 });
        expect(recorded.at(-1)?.headers).not.toHaveProperty("x-tf-device");
    });

    it("keeps the gateway's error code in the failure, so a revoked device is recognised", async () => {
        reply = { status: 401, body: JSON.stringify({ error: "device_revoked" }) };
        const failure = await provider.exec({
            method: "POST", url: "https://nb-example.invalid/api/login/sync", proxy: null, timeout: 1000, headers: { "x-tf-device": "dev_token" }
        }).catch((e: Error) => e);
        expect(failure).toBeInstanceOf(Error);
        expect(classifyTfSyncError((failure as Error).message)).toBe("device_revoked");
    });
});
