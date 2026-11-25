/**
 * One voice note from the first press to the transcript: the recorder, the bar that shows it,
 * the upload of the audio into the note and the transcript under its embed. One recording at a
 * time, as there is one microphone.
 */
import type { CKTextEditor } from "@triliumnext/ckeditor5";
import { h, render } from "preact";

import appContext from "../../../components/app_context.js";
import type FAttachment from "../../../entities/fattachment.js";
import froca from "../../../services/froca.js";
import { t } from "../../../services/i18n.js";
import server from "../../../services/server.js";
import toast from "../../../services/toast.js";
import { getTfBridge } from "../../bridge.js";
import { fetchWithRefresh } from "../../gateway.js";
import { getTfClientId, TF_BASE_BLOB_HEADER, TF_CLIENT_ID_HEADER } from "../../save_guard.js";
import { getTfBootstrap } from "../../state.js";
import { clearMarker, editorNoteId, findAttachmentEmbed, insertTranscript, isEditorAlive, markStart, placementFor, type StartedUpload, uploadAtPlace } from "./editor_ops.js";
import { insertAfterAttachmentEmbed, recordingFileName, transcriptHtml } from "./placement.js";
import { browserRecorderDeps, type RecorderDeps, type RecorderErrorCode, type RecorderSnapshot, VoiceRecorder } from "./recorder.js";
import { canRetry, isTooLongForTranscript, requestTranscript, routeTypeOf, setEmbedVoiceStatus, type TranscriptOutcome } from "./transcribe.js";

export type VoicePhase = "recorder" | "saving" | "save_failed" | "mic_error" | "closed";

export interface VoiceView {
    phase: VoicePhase;
    snapshot: RecorderSnapshot;
    percent: number;
    message: string | null;
    downloadUrl: string | null;
    downloadName: string | null;
}

let active: VoiceSession | null = null;
let depsOverride: RecorderDeps | null = null;

/** Whether this person may record into notes here: embedded, with the `edit` role. */
export function canRecordHere() {
    return getTfBootstrap()?.user?.role === "edit";
}

export function getActiveVoiceSession() {
    return active;
}

/** For the end-to-end checks: the recorder's browser dependencies. */
export function setVoiceRecorderDeps(deps: RecorderDeps | null) {
    depsOverride = deps;
}

/** Starts a recording at the caret of `editor`. */
export async function startVoiceNote(editor: CKTextEditor) {
    if (!canRecordHere()) {
        return;
    }
    if (active && active.view.phase !== "closed") {
        toast.showMessage(t("tf.reach.already_recording"), 3000, "bx bx-microphone");
        active.focusBar();
        return;
    }
    const noteId = editorNoteId(editor);
    if (!noteId || editor.isReadOnly) {
        return;
    }
    const session = new VoiceSession(editor, noteId);
    active = session;
    await session.start();
}

export class VoiceSession {
    readonly recorder: VoiceRecorder;
    view: VoiceView;
    private readonly listeners = new Set<() => void>();
    private readonly startedAt = new Date();
    private readonly markerName: string;
    private container: HTMLElement | null = null;
    private blob: Blob | null = null;
    private upload: StartedUpload | null = null;
    private progressTimer: ReturnType<typeof setInterval> | null = null;

    constructor(readonly editor: CKTextEditor, readonly noteId: string) {
        this.recorder = new VoiceRecorder(depsOverride ?? browserRecorderDeps());
        this.view = { phase: "recorder", snapshot: this.recorder.snapshot(), percent: 0, message: null, downloadUrl: null, downloadName: null };
        this.markerName = markStart(editor, String(this.startedAt.getTime()));
        this.recorder.onChange((snapshot) => {
            this.update({ snapshot });
            if (snapshot.state === "stopped" && this.view.phase === "recorder") {
                void this.finish();
            } else if (snapshot.state === "closed" && this.view.phase === "recorder") {
                this.close();
            } else if (snapshot.state === "failed" && snapshot.error) {
                this.onMicError(snapshot.error);
            }
        });
    }

    subscribe(listener: () => void) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    async start() {
        this.mountBar();
        await this.recorder.start();
    }

    /** Stop and save. */
    stop() {
        void this.recorder.stop();
    }

    /** "Try again" after the microphone failed: asks for it again. */
    async retryMicrophone() {
        this.update({ phase: "recorder", message: null });
        await this.recorder.start();
    }

    /** "Try again" after the upload failed: the audio is still in memory. */
    async retrySave() {
        if (this.blob) {
            await this.save(this.blob);
        }
    }

    close() {
        if (this.view.phase === "closed") {
            return;
        }
        this.recorder.dispose();
        if (this.progressTimer) {
            clearInterval(this.progressTimer);
        }
        if (this.view.downloadUrl) {
            URL.revokeObjectURL(this.view.downloadUrl);
        }
        clearMarker(this.editor, this.markerName);
        this.update({ phase: "closed" });
        if (this.container) {
            render(null, this.container);
            this.container.remove();
            this.container = null;
        }
        if (active === this) {
            active = null;
        }
    }

    focusBar() {
        this.container?.querySelector<HTMLElement>("button")?.focus();
    }

    private onMicError(code: RecorderErrorCode) {
        const message = t(MIC_MESSAGES[code]);
        this.update({ phase: "mic_error", message });
        clearMarker(this.editor, this.markerName);
        getTfBridge()?.notify("toast", { kind: "error", message });
    }

    private async finish() {
        this.blob = this.recorder.blob();
        await this.save(this.blob);
    }

    private async save(blob: Blob) {
        this.update({ phase: "saving", percent: 0, message: null });
        const mime = this.recorder.mime;
        const file = new File([ blob ], recordingFileName(this.startedAt, mime.extension), { type: mime.fileType });

        let editor = this.editor;
        let markerName: string | null = this.markerName;
        if (placementFor(editor, this.noteId, this.markerName) === "reopen") {
            const reopened = await openEditorOfNote(this.noteId);
            if (!reopened) {
                this.saveFailed(file);
                return;
            }
            editor = reopened;
            markerName = null;
        }

        this.upload = uploadAtPlace(editor, file, markerName);
        if (!this.upload) {
            this.saveFailed(file);
            return;
        }
        const upload = this.upload;
        this.progressTimer = setInterval(() => this.update({ percent: upload.progress() }), 200);
        const attachmentId = await upload.done;
        if (this.progressTimer) {
            clearInterval(this.progressTimer);
            this.progressTimer = null;
        }
        if (!attachmentId) {
            this.saveFailed(file);
            return;
        }

        this.close();
        void transcribeIntoNote({
            editor,
            noteId: this.noteId,
            attachmentId,
            audio: blob,
            type: mime.fileType,
            seconds: this.view.snapshot.elapsedMs / 1000
        });
    }

    private saveFailed(file: File) {
        if (this.view.downloadUrl) {
            URL.revokeObjectURL(this.view.downloadUrl);
        }
        this.update({
            phase: "save_failed",
            message: t("tf.reach.save_failed"),
            downloadUrl: URL.createObjectURL(file),
            downloadName: file.name
        });
    }

    private mountBar() {
        const container = document.createElement("div");
        container.className = "tf-voice-bar-host";
        document.body.append(container);
        this.container = container;
        void import("./RecorderBar.js").then(({ default: RecorderBar }) => {
            if (this.container === container) {
                render(h(RecorderBar, { session: this }), container);
            }
        });
    }

    private update(patch: Partial<VoiceView>) {
        this.view = { ...this.view, ...patch };
        for (const listener of this.listeners) {
            listener();
        }
    }
}

const MIC_MESSAGES: Record<RecorderErrorCode, string> = {
    denied: "tf.reach.mic_denied",
    no_mic: "tf.reach.mic_missing",
    unsupported: "tf.reach.mic_unsupported",
    failed: "tf.reach.mic_failed"
};

/**
 * Makes a transcript of an audio attachment and puts it under its embed. The audio is the
 * recording just made, or read again from the engine (`audio` left out), so a "Try again" later
 * needs nothing kept in memory. The embed shows how it goes (`setEmbedVoiceStatus()`).
 */
export async function transcribeIntoNote({ editor, noteId, attachmentId, audio, type, seconds }: {
    editor: CKTextEditor | null;
    noteId: string;
    attachmentId: string;
    audio?: Blob;
    type?: string;
    seconds?: number | null;
}): Promise<TranscriptOutcome> {
    setEmbedVoiceStatus(attachmentId, { state: "working" });
    let outcome: TranscriptOutcome;
    try {
        let blob = audio;
        let mime = type;
        let length = seconds ?? null;
        if (!blob) {
            const read = await readAttachmentAudio(attachmentId);
            blob = read.blob;
            mime = read.type;
            length = await audioSeconds(blob);
        }
        if (!routeTypeOf(mime)) {
            outcome = { ok: false, kind: "unsupported", message: null };
        } else if (isTooLongForTranscript(blob.size, length)) {
            outcome = { ok: false, kind: "too_long", message: null };
        } else {
            outcome = await requestTranscript(blob, mime ?? blob.type);
        }
    } catch {
        outcome = { ok: false, kind: "failed", message: null };
    }

    if (!outcome.ok) {
        setEmbedVoiceStatus(attachmentId, { state: "error", kind: outcome.kind, message: outcome.message });
        return outcome;
    }

    const text = outcome.transcript.text.trim();
    if (!text) {
        setEmbedVoiceStatus(attachmentId, { state: "error", kind: "empty", message: null });
        return { ok: false, kind: "empty", message: null };
    }
    try {
        await putTranscriptInNote(editor, noteId, attachmentId, text);
    } catch {
        // The transcript was made; the note did not take it. Say so, and keep "Try again".
        toast.showError(t("tf.reach.transcript_not_added"));
        setEmbedVoiceStatus(attachmentId, { state: "error", kind: "failed", message: null });
        return { ok: false, kind: "failed", message: null };
    }
    setEmbedVoiceStatus(attachmentId, null);
    return outcome;
}

/** "Make a transcript" on an audio embed, and "Try again" under one. */
export async function makeTranscriptOfAttachment(attachment: FAttachment, editor: CKTextEditor | null) {
    if (!canRecordHere()) {
        return;
    }
    if (!routeTypeOf(attachment.mime)) {
        setEmbedVoiceStatus(attachment.attachmentId, { state: "error", kind: "unsupported", message: null });
        return;
    }
    if (isTooLongForTranscript(attachment.contentLength ?? 0, null)) {
        setEmbedVoiceStatus(attachment.attachmentId, { state: "error", kind: "too_long", message: null });
        return;
    }
    await transcribeIntoNote({ editor, noteId: attachment.ownerId, attachmentId: attachment.attachmentId });
}

export function transcriptCanRetry(kind: Parameters<typeof canRetry>[0]) {
    return canRetry(kind);
}

/** How long a transcript waits for someone else's turn on the note to end. */
const TURN_WAIT_MS = 60_000;
const SAVED_NOTE_ATTEMPTS = 3;

async function putTranscriptInNote(editor: CKTextEditor | null, noteId: string, attachmentId: string, text: string) {
    const title = t("tf.reach.transcript");
    const until = Date.now() + TURN_WAIT_MS;
    for (;;) {
        const target = editor && isEditorAlive(editor) && editorNoteId(editor) === noteId
            ? editor
            : await findOpenEditorOfNote(noteId);
        const embed = target ? findAttachmentEmbed(target, attachmentId) : null;
        if (!target || !embed) {
            break;
        }
        if (insertTranscript(target, embed, text, title)) {
            return;
        }
        // Read-only while someone else has the turn: the text waits for it, then goes in as an edit.
        if (Date.now() > until) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // No open editor takes it: the transcript goes into the saved note itself, from the blob just
    // read, read again when someone saved in between.
    const html = transcriptHtml(text, title, true);
    for (let attempt = 0; attempt < SAVED_NOTE_ATTEMPTS; attempt++) {
        const blob = await server.get<{ blobId?: string; content?: string }>(`notes/${noteId}/blob`);
        const content = typeof blob?.content === "string" ? blob.content : "";
        const status = await putNoteData(noteId, insertAfterAttachmentEmbed(content, attachmentId, html), blob?.blobId);
        if (status !== 409) {
            return;
        }
    }
    throw new Error("The note kept changing.");
}

/**
 * `PUT notes/:noteId/data` with the blob it was read from as `tf-base-blob`, past the save guard's
 * conflict dialog: a 409 comes back as the status, for the caller to read the note again.
 */
async function putNoteData(noteId: string, content: string, baseBlobId: string | undefined) {
    const sent: Record<string, string> = { "Content-Type": "application/json", [TF_CLIENT_ID_HEADER]: getTfClientId() };
    for (const [ name, value ] of Object.entries(await server.getHeaders())) {
        if (value) {
            sent[name] = value;
        }
    }
    if (baseBlobId) {
        sent[TF_BASE_BLOB_HEADER] = baseBlobId;
    }
    const response = await fetchWithRefresh(() => fetch(`${window.glob.baseApiUrl}notes/${encodeURIComponent(noteId)}/data`, {
        method: "PUT",
        credentials: "same-origin",
        headers: sent,
        body: JSON.stringify({ content })
    }));
    if (!response.ok && response.status !== 409) {
        throw new Error(`save ${response.status}`);
    }
    return response.status;
}

async function readAttachmentAudio(attachmentId: string) {
    const headers = await server.getHeaders();
    const sent: Record<string, string> = {};
    for (const [ name, value ] of Object.entries(headers)) {
        if (value) {
            sent[name] = value;
        }
    }
    const response = await fetch(`${window.glob.baseApiUrl}attachments/${encodeURIComponent(attachmentId)}/open`, {
        credentials: "same-origin",
        headers: sent
    });
    if (!response.ok) {
        throw new Error(`attachment ${response.status}`);
    }
    const blob = await response.blob();
    const attachment = await froca.getAttachment(attachmentId, true);
    return { blob, type: attachment?.mime ?? blob.type };
}

/** The length of audio in seconds, or `null` when the browser cannot tell (WebM from a recorder). */
function audioSeconds(blob: Blob): Promise<number | null> {
    return new Promise((resolve) => {
        const url = URL.createObjectURL(blob);
        const audio = new Audio();
        const done = (value: number | null) => {
            clearTimeout(timer);
            URL.revokeObjectURL(url);
            audio.removeAttribute("src");
            resolve(value);
        };
        const timer = setTimeout(() => done(null), 4000);
        audio.preload = "metadata";
        audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : null);
        audio.onerror = () => done(null);
        audio.src = url;
    });
}

async function findOpenEditorOfNote(noteId: string): Promise<CKTextEditor | null> {
    for (const context of appContext.tabManager.getNoteContexts()) {
        if (context.note?.noteId !== noteId || context.note.type !== "text") {
            continue;
        }
        try {
            const editor = await context.getTextEditor();
            if (editor && isEditorAlive(editor) && editorNoteId(editor) === noteId) {
                return editor;
            }
        } catch {
            // That context shows the note in another mode.
        }
    }
    return null;
}

/** Shows `noteId` in the active tab again and waits for its editor. */
async function openEditorOfNote(noteId: string): Promise<CKTextEditor | null> {
    const open = await findOpenEditorOfNote(noteId);
    if (open) {
        return open;
    }
    const context = appContext.tabManager.getActiveContext();
    if (!context) {
        return null;
    }
    await context.setNote(noteId);
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
        const editor = await findOpenEditorOfNote(noteId);
        if (editor) {
            return editor;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
}

/**
 * "Record a voice note" among the tree's new-note choices: a text note named after the time,
 * which opens and starts recording.
 */
export async function recordIntoNewNote(parentNotePath: string, target: "into" | "after", targetBranchId?: string) {
    if (!canRecordHere()) {
        return;
    }
    const { default: noteCreateService } = await import("../../../services/note_create.js");
    const when = new Intl.DateTimeFormat(document.documentElement.lang || undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date());
    const created = await noteCreateService.createNote(parentNotePath, {
        type: "text",
        title: t("tf.reach.voice_note_title", { when }),
        content: "",
        target,
        targetBranchId,
        activate: true,
        focus: "content"
    });
    const noteId = created?.note?.noteId;
    if (!noteId) {
        return;
    }
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
        const editor = await findOpenEditorOfNote(noteId);
        if (editor) {
            await startVoiceNote(editor);
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}
