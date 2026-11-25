import { describe, expect, it } from "vitest";

import { REPLACE_PART_BYTES, TfGateway, TfGatewayError } from "./gateway";

interface Call { url: string; method?: string; headers: Record<string, string>; size: number }

function fakeFetch(answer: (call: Call) => Response) {
    const calls: Call[] = [];
    const fetchFn = async (url: string, init: RequestInit) => {
        const body = init.body as Uint8Array | string | undefined;
        const call = { url, method: init.method, headers: { ...(init.headers as Record<string, string>) }, size: body ? (typeof body === "string" ? body.length : body.byteLength) : 0 };
        calls.push(call);
        return answer(call);
    };
    return { calls, fetchFn };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("notes gateway client", () => {
    it("asks for the update with the pair code or the device key", async () => {
        const update = { engine: { version: "1", syncVersion: 41 }, app: null, replace: true };
        const { calls, fetchFn } = fakeFetch(() => json(update));
        const gateway = new TfGateway("https://nb-example.invalid", fetchFn);
        await expect(gateway.getUpdate({ pairCode: "CODE" })).resolves.toEqual(update);
        await gateway.getUpdate({ deviceToken: "tok" });
        expect(calls.map((c) => [ c.url, c.method, c.headers ])).toEqual([
            [ "https://nb-example.invalid/__tf/desktop/update", "GET", { "x-tf-pair-code": "CODE" } ],
            [ "https://nb-example.invalid/__tf/desktop/update", "GET", { "x-tf-device": "tok" } ]
        ]);
    });

    it("reports the gateway's error codes", async () => {
        const gateway = new TfGateway("https://nb-example.invalid", fakeFetch(() => json({ error: "not_eligible" }, 403)).fetchFn);
        await expect(gateway.getUpdate({ pairCode: "C" })).rejects.toMatchObject({ status: 403, code: "not_eligible" });
        const offline = new TfGateway("https://nb-example.invalid", async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); });
        await expect(offline.getUpdate({ pairCode: "C" })).rejects.toBeInstanceOf(TfGatewayError);
        await expect(offline.getUpdate({ pairCode: "C" })).rejects.toMatchObject({ status: 0 });
    });

    it("refuses a redeem answer without the document seed", async () => {
        const gateway = new TfGateway("https://nb-example.invalid", fakeFetch(() => json({ deviceToken: "t", deviceId: "d", syncServerHost: "https://nb-example.invalid", seed: [] })).fetchFn);
        await expect(gateway.redeem({ code: "C", deviceName: "Mac", appVersion: "1", appBuild: 1, syncVersion: 41 })).rejects.toMatchObject({ code: "bad_answer" });
    });

    it("sends the database in parts of at most 64 MiB, the last one runs the import", async () => {
        const total = REPLACE_PART_BYTES * 2 + 10;
        const { calls, fetchFn } = fakeFetch((call) => (call.url.includes("part=3") ? json({ ok: true, notes: 42 }) : json({ ok: true, received: 1 })));
        const gateway = new TfGateway("https://nb-example.invalid", fetchFn);
        const reads: [number, number, number][] = [];
        const progress: number[] = [];
        const result = await gateway.replace("CODE", total, async (part, start, length) => {
            reads.push([ part, start, length ]);
            return new Uint8Array(length);
        }, (sent) => progress.push(sent));
        expect(result).toEqual({ notes: 42 });
        expect(calls.map((c) => [ c.url.replace("https://nb-example.invalid", ""), c.size, c.headers["x-tf-pair-code"], c.headers["content-type"] ])).toEqual([
            [ "/__tf/desktop/replace?part=1&parts=3", REPLACE_PART_BYTES, "CODE", "application/octet-stream" ],
            [ "/__tf/desktop/replace?part=2&parts=3", REPLACE_PART_BYTES, "CODE", "application/octet-stream" ],
            [ "/__tf/desktop/replace?part=3&parts=3", 10, "CODE", "application/octet-stream" ]
        ]);
        expect(reads).toEqual([ [ 1, 0, REPLACE_PART_BYTES ], [ 2, REPLACE_PART_BYTES, REPLACE_PART_BYTES ], [ 3, REPLACE_PART_BYTES * 2, 10 ] ]);
        expect(progress).toEqual([ REPLACE_PART_BYTES, REPLACE_PART_BYTES * 2, total ]);

        const small = fakeFetch(() => json({ ok: true, notes: 3 }));
        await new TfGateway("https://nb-example.invalid", small.fetchFn).replace("CODE", 1000, async (_p, _s, length) => new Uint8Array(length), () => {});
        expect(small.calls.map((c) => c.url)).toEqual([ "https://nb-example.invalid/__tf/desktop/replace?part=1&parts=1" ]);

        const failing = fakeFetch(() => json({ error: "bad_part", message: "start again" }, 400));
        await expect(new TfGateway("https://nb-example.invalid", failing.fetchFn).replace("CODE", 10, async () => new Uint8Array(10), () => {}))
            .rejects.toMatchObject({ status: 400, code: "bad_part", message: "start again" });
    });
});
