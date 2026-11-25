/**
 * The notes gateway's desktop routes (`/__tf/desktop/*`), as the main process calls them. The
 * contract is `infra/notes/DESKTOP.md` in the Taskforce repository.
 */

export type GatewayFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface TfGatewayBuild {
    version: string;
    build: number;
    syncVersion: number;
    dbVersion: number;
    url: string;
    sha256: string;
    size: number;
    builtAt: string;
}

export interface TfUpdateAnswer {
    engine: { version: string; syncVersion: number };
    app: TfGatewayBuild | null;
    replace: boolean;
    /** Optional: the notebook's name and its person, so the connect screen can name them. */
    notebookName?: string;
    userName?: string;
}

export interface TfRedeemRequest {
    code: string;
    deviceName: string;
    appVersion: string;
    appBuild: number;
    syncVersion: number;
}

export interface TfSeedOption {
    name: string;
    value: string;
    isSynced: boolean;
}

export interface TfRedeemAnswer {
    deviceId: string;
    deviceToken: string;
    notebookId: string;
    notebookName: string;
    userName: string;
    syncServerHost: string;
    seed: TfSeedOption[];
    syncVersion: number;
}

/** A refused or failed gateway call: `status` 0 means no answer (network). */
export class TfGatewayError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
        this.name = "TfGatewayError";
    }
}

/** Each part of a replace upload, at most 64 MiB (the proxy in front refuses bodies over 100 MB). */
export const REPLACE_PART_BYTES = 64 * 1024 * 1024;

const SHORT_TIMEOUT_MS = 30_000;
const PART_TIMEOUT_MS = 5 * 60_000;
const IMPORT_TIMEOUT_MS = 20 * 60_000;

export class TfGateway {
    constructor(private readonly server: string, private readonly fetchFn: GatewayFetch) {}

    /** `GET /__tf/desktop/update`, authorised by a pair code or a device key. */
    async getUpdate(auth: { pairCode: string } | { deviceToken: string }): Promise<TfUpdateAnswer> {
        const headers: Record<string, string> = "pairCode" in auth
            ? { "x-tf-pair-code": auth.pairCode }
            : { "x-tf-device": auth.deviceToken };
        const answer = await this.call("GET", "/__tf/desktop/update", { headers }, SHORT_TIMEOUT_MS);
        if (!isUpdateAnswer(answer)) {
            throw new TfGatewayError(502, "bad_answer", "The notebook gave an answer this app does not understand.");
        }
        return answer;
    }

    /** `POST /__tf/desktop/redeem`: uses the code up and answers the device key and the seed. */
    async redeem(body: TfRedeemRequest): Promise<TfRedeemAnswer> {
        const answer = await this.call("POST", "/__tf/desktop/redeem", {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
        }, SHORT_TIMEOUT_MS);
        if (!isRedeemAnswer(answer)) {
            throw new TfGatewayError(502, "bad_answer", "The notebook gave an answer this app does not understand.");
        }
        return answer;
    }

    /**
     * `POST /__tf/desktop/replace?part=<n>&parts=<total>`, one part after the other. `readPart`
     * gives the bytes of a part (1-based). Answers the note count of the imported database.
     */
    async replace(pairCode: string, totalBytes: number, readPart: (part: number, start: number, length: number) => Promise<Uint8Array>,
        onProgress: (sentBytes: number) => void): Promise<{ notes: number }> {
        const parts = Math.max(1, Math.ceil(totalBytes / REPLACE_PART_BYTES));
        let sent = 0;
        for (let part = 1; part <= parts; part++) {
            const start = (part - 1) * REPLACE_PART_BYTES;
            const length = Math.min(REPLACE_PART_BYTES, totalBytes - start);
            const bytes = await readPart(part, start, length);
            const last = part === parts;
            const answer = await this.call("POST", `/__tf/desktop/replace?part=${part}&parts=${parts}`, {
                headers: { "x-tf-pair-code": pairCode, "content-type": "application/octet-stream" },
                body: bytes as unknown as BodyInit
            }, last ? IMPORT_TIMEOUT_MS : PART_TIMEOUT_MS) as { ok?: boolean; received?: number; notes?: number } | null;
            if (!answer?.ok) {
                throw new TfGatewayError(502, "bad_answer", "The notebook did not accept the notes.");
            }
            sent += length;
            onProgress(sent);
            if (last) {
                return { notes: typeof answer.notes === "number" ? answer.notes : 0 };
            }
        }
        throw new TfGatewayError(502, "bad_answer", "The notebook did not finish the import.");
    }

    private async call(method: string, path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
        let response: Response;
        try {
            response = await this.fetchFn(`${this.server}${path}`, {
                ...init,
                method,
                redirect: "error",
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (e) {
            throw new TfGatewayError(0, "network", e instanceof Error ? e.message : String(e));
        }
        const text = await response.text();
        let json: unknown = null;
        try {
            json = text ? JSON.parse(text) : null;
        } catch {
            json = null;
        }
        if (!response.ok) {
            const body = (json ?? {}) as { error?: unknown; message?: unknown };
            const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
            const message = typeof body.message === "string" ? body.message : `${response.status} ${response.statusText}`;
            throw new TfGatewayError(response.status, code, message);
        }
        return json;
    }
}

function isUpdateAnswer(value: unknown): value is TfUpdateAnswer {
    const answer = value as TfUpdateAnswer | null;
    return !!answer && typeof answer.engine?.syncVersion === "number" && typeof answer.replace === "boolean"
        && (answer.app === null || typeof answer.app === "object");
}

export function isRedeemAnswer(value: unknown): value is TfRedeemAnswer {
    const answer = value as TfRedeemAnswer | null;
    return !!answer
        && typeof answer.deviceToken === "string" && answer.deviceToken.length > 0
        && typeof answer.deviceId === "string"
        && typeof answer.syncServerHost === "string"
        && Array.isArray(answer.seed)
        && answer.seed.some((option) => option?.name === "documentId")
        && answer.seed.some((option) => option?.name === "documentSecret")
        && answer.seed.every((option) => typeof option?.name === "string" && typeof option.value === "string");
}
