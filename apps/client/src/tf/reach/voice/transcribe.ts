/**
 * Transcripts of audio in a note: the `voice/transcribe` route, what its answers mean for the
 * person, and the in-memory status each audio embed shows while one is made.
 */
import { tfFetch, TfGatewayError } from "../../gateway.js";
import { VOICE_MAX_BYTES, VOICE_MAX_MS } from "./recorder.js";

export interface VoiceTranscript {
    text: string;
    language: string;
    seconds: number;
}

export type TranscriptFailure = "budget" | "not_configured" | "too_long" | "unsupported" | "empty" | "failed";

export type TranscriptOutcome =
    | { ok: true; transcript: VoiceTranscript }
    | { ok: false; kind: TranscriptFailure; message: string | null };

/** The types the route takes, without codec parameters. */
const ROUTE_TYPES = new Set([ "audio/webm", "audio/mp4", "audio/wav" ]);
const TYPE_ALIASES: Record<string, string> = {
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/vnd.wave": "audio/wav",
    "audio/x-m4a": "audio/mp4",
    "audio/m4a": "audio/mp4",
    "video/webm": "audio/webm",
    "video/mp4": "audio/mp4"
};

/** The type to send for a file of `mime`, or `null` when the route does not take it. */
export function routeTypeOf(mime: string | null | undefined) {
    const base = (mime ?? "").split(";")[0].trim().toLowerCase();
    const type = TYPE_ALIASES[base] ?? base;
    return ROUTE_TYPES.has(type) ? type : null;
}

/** Whether audio of this size and length is too long to send (`seconds` unknown: only the size counts). */
export function isTooLongForTranscript(bytes: number, seconds: number | null | undefined) {
    if (bytes > VOICE_MAX_BYTES) {
        return true;
    }
    return typeof seconds === "number" && Number.isFinite(seconds) && seconds * 1000 > VOICE_MAX_MS + 999;
}

/** Sorts an error answer of the route. */
export function outcomeFromError(status: number, body: unknown): TranscriptOutcome {
    const message = typeof (body as { message?: unknown } | null)?.message === "string"
        ? (body as { message: string }).message
        : null;
    const code = (body as { error?: unknown } | null)?.error;
    if (status === 429 || code === "ai_budget_used_up") {
        return { ok: false, kind: "budget", message };
    }
    if (status === 503 || code === "ai_not_configured") {
        return { ok: false, kind: "not_configured", message };
    }
    if (status === 413 || code === "too_long") {
        return { ok: false, kind: "too_long", message };
    }
    if (status === 415 || code === "unsupported_type") {
        return { ok: false, kind: "unsupported", message };
    }
    return { ok: false, kind: "failed", message };
}

/** Posts `audio` as `type` to `voice/transcribe`. Never throws. */
export async function requestTranscript(audio: Blob, type: string, fetchImpl: typeof tfFetch = tfFetch): Promise<TranscriptOutcome> {
    const routeType = routeTypeOf(type);
    if (!routeType) {
        return { ok: false, kind: "unsupported", message: null };
    }
    if (isTooLongForTranscript(audio.size, null)) {
        return { ok: false, kind: "too_long", message: null };
    }
    try {
        const transcript = await fetchImpl<VoiceTranscript>("voice/transcribe", {
            method: "POST",
            body: audio,
            headers: { "Content-Type": routeType }
        });
        if (!transcript || typeof transcript.text !== "string") {
            return { ok: false, kind: "failed", message: null };
        }
        return { ok: true, transcript };
    } catch (e) {
        if (e instanceof TfGatewayError) {
            return outcomeFromError(e.status, e.body);
        }
        return { ok: false, kind: "failed", message: null };
    }
}

export type EmbedVoiceStatus =
    | { state: "working" }
    | { state: "error"; kind: TranscriptFailure; message: string | null };

const statuses = new Map<string, EmbedVoiceStatus>();
const listeners = new Set<() => void>();

export function getEmbedVoiceStatus(attachmentId: string) {
    return statuses.get(attachmentId) ?? null;
}

export function setEmbedVoiceStatus(attachmentId: string, status: EmbedVoiceStatus | null) {
    if (status) {
        statuses.set(attachmentId, status);
    } else {
        statuses.delete(attachmentId);
    }
    for (const listener of listeners) {
        listener();
    }
}

export function subscribeEmbedVoiceStatus(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Whether "Try again" can help after `kind`. */
export function canRetry(kind: TranscriptFailure) {
    return kind !== "too_long" && kind !== "unsupported" && kind !== "empty" && kind !== "not_configured";
}

/** A sentence ending in a full stop, whether or not `message` has one. */
export function withFullStop(message: string) {
    const trimmed = message.trim();
    return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
