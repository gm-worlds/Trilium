import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    triggerEvent: vi.fn(),
    post: vi.fn(async () => ({})),
    showError: vi.fn(),
    renewSession: vi.fn(async () => true)
}));

vi.mock("../components/app_context.js", () => ({ default: { triggerEvent: mocks.triggerEvent } }));
vi.mock("../services/froca.js", () => ({
    default: {
        notes: {
            n1: {
                noteId: "n1", title: "Plan", type: "text", mime: "text/html",
                getParentBranches: () => [ { parentNoteId: "root", branchId: "b1" } ]
            }
        }
    }
}));
vi.mock("../services/server.js", () => ({ default: { post: mocks.post } }));
vi.mock("../services/toast.js", () => ({ default: { showError: mocks.showError } }));
vi.mock("./gateway.js", () => ({ renewSession: mocks.renewSession }));
vi.mock("../widgets/react/Button.js", () => ({ default: () => null }));
vi.mock("../widgets/react/Modal.js", () => ({ default: () => null }));

import { getTfClientId, setConflictAsker, TF_BASE_BLOB_HEADER, TF_CLIENT_ID_HEADER, tfCallInterceptor } from "./save_guard.js";
import { getTfBaseBlob, setTfBaseBlob, type TfCallNext, type TfInterceptedOptions } from "./state.js";

interface Call {
    headers?: Record<string, string>;
}

/** A `next` that answers each call with the next scripted outcome, like `server.ts` would. */
function scriptedNext(outcomes: ({ status: number; body: unknown })[]) {
    const calls: Call[] = [];
    const next: TfCallNext = async (_method, _url, _componentId, options: TfInterceptedOptions) => {
        calls.push({ headers: options.tf?.headers });
        const outcome = outcomes.shift();
        if (!outcome) {
            throw new Error("no outcome");
        }
        if (outcome.status >= 400) {
            const text = JSON.stringify(outcome.body);
            const silenced = options.tf?.silence?.(outcome.status, text);
            throw silenced ? text : new Error(`reported ${outcome.status}`);
        }
        return outcome.body;
    };
    return { next, calls };
}

const conflict = { conflict: true, blobId: "theirs", editedBy: { id: "bob", name: "Bob" }, editedAt: "t" };

describe("tf save guard (client)", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setTfBaseBlob("n1", "base");
    });

    it("sends the base blob and keeps the new one after a save", async () => {
        const { next, calls } = scriptedNext([ { status: 200, body: { blobId: "after" } } ]);
        await tfCallInterceptor("PUT", "notes/n1/data", "c", { data: { content: "x" } }, next);
        expect(calls[0].headers).toEqual({ [TF_BASE_BLOB_HEADER]: "base", [TF_CLIENT_ID_HEADER]: getTfClientId() });
        expect(getTfClientId()).toMatch(/^[0-9a-f]{24}$/);
        expect(getTfBaseBlob("n1")).toBe("after");

        const other = scriptedNext([ { status: 200, body: { ok: true } } ]);
        await tfCallInterceptor("GET", "notes/n1", "c", {}, other.next);
        expect(other.calls[0].headers).toBeUndefined();
    });

    it("on a conflict, 'Use mine' forces the write", async () => {
        const ask = vi.fn(async () => "mine" as const);
        setConflictAsker(ask);
        const { next, calls } = scriptedNext([
            { status: 409, body: conflict },
            { status: 200, body: { blobId: "mine" } }
        ]);

        await expect(tfCallInterceptor("PUT", "notes/n1/data", "c", { data: { content: "x" } }, next))
            .resolves.toEqual({ blobId: "mine" });
        expect(ask).toHaveBeenCalledWith("n1", conflict);
        expect(calls.map((call) => call.headers?.[TF_BASE_BLOB_HEADER])).toEqual([ "base", "*" ]);
        expect(calls.every((call) => call.headers?.[TF_CLIENT_ID_HEADER] === getTfClientId())).toBe(true);
        expect(getTfBaseBlob("n1")).toBe("mine");
    });

    it("on a conflict, 'Use theirs' drops the save and reloads their version", async () => {
        setConflictAsker(async () => "theirs");
        const { next, calls } = scriptedNext([ { status: 409, body: conflict } ]);

        await expect(tfCallInterceptor("PUT", "notes/n1/data", "c", { data: { content: "x" } }, next)).resolves.toBeUndefined();
        expect(calls).toHaveLength(1);
        expect(getTfBaseBlob("n1")).toBe("theirs");
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mocks.triggerEvent).toHaveBeenCalledWith("entitiesReloaded", expect.anything());
        expect(mocks.post).not.toHaveBeenCalled();
    });

    it("on a conflict, 'Keep both' saves the local text as a sibling note first", async () => {
        setConflictAsker(async () => "keepBoth");
        const { next } = scriptedNext([ { status: 409, body: conflict } ]);

        await tfCallInterceptor("PUT", "notes/n1/data", "c", { data: { content: "<p>mine</p>" } }, next);
        expect(mocks.post).toHaveBeenCalledWith(
            "notes/root/children?target=after&targetBranchId=b1",
            expect.objectContaining({ type: "text", content: "<p>mine</p>" })
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(mocks.triggerEvent).toHaveBeenCalled();
    });

    it("renews the gateway session once after a 401 and shows one toast for a read-only refusal", async () => {
        const { next, calls } = scriptedNext([
            { status: 401, body: {} },
            { status: 200, body: { done: true } }
        ]);
        await expect(tfCallInterceptor("GET", "tree", undefined, {}, next)).resolves.toEqual({ done: true });
        expect(mocks.renewSession).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(2);

        const readOnly = scriptedNext([ { status: 403, body: { tfReadOnly: true } } ]);
        await expect(tfCallInterceptor("POST", "notes/root/children", undefined, {}, readOnly.next)).rejects.toBeDefined();
        expect(mocks.showError).toHaveBeenCalledTimes(1);

        const gatewayRefusal = scriptedNext([ { status: 403, body: { error: "read_only" } } ]);
        await expect(tfCallInterceptor("PUT", "branches/b1/expanded/1", undefined, {}, gatewayRefusal.next)).rejects.toBeDefined();

        const other = scriptedNext([ { status: 500, body: { message: "boom" } } ]);
        await expect(tfCallInterceptor("GET", "x", undefined, {}, other.next)).rejects.toThrow("reported 500");
    });
});
