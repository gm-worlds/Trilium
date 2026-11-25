/**
 * The voice recorder: microphone, `MediaRecorder` and the rules around them (pause, resume, stop,
 * discard with undo, the 20-minute limit, pausing while the page is hidden or the microphone is
 * gone). No DOM of its own; the recorder bar draws its state.
 */

/** The longest recording, which is also the longest the transcript route takes. */
export const VOICE_MAX_MS = 20 * 60 * 1000;
/** When the recorder warns that the end is near. */
export const VOICE_WARN_MS = 19 * 60 * 1000;
/** How long a discarded recording can still be brought back. */
export const VOICE_UNDO_MS = 5000;
/** The largest recording the transcript route takes. */
export const VOICE_MAX_BYTES = 25 * 1024 * 1024;
export const VOICE_BITS_PER_SECOND = 32_000;

const TICK_MS = 250;
const TIMESLICE_MS = 1000;

export type RecorderState = "idle" | "starting" | "recording" | "paused" | "discarded" | "stopping" | "stopped" | "closed" | "failed";
export type PauseReason = "user" | "hidden" | "lost";
export type RecorderErrorCode = "denied" | "no_mic" | "unsupported" | "failed";

/** The container types the transcript route takes, best first. */
const MIME_CANDIDATES = [
    "audio/webm;codecs=opus",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/webm"
];

export interface VoiceMime {
    /** What `MediaRecorder` is asked for, or `undefined` to let it pick. */
    recorderType: string | undefined;
    /** The type of the file without codec parameters, as the attachment and the transcript route take it. */
    fileType: string;
    extension: string;
}

/** The best type this browser records, by `isTypeSupported()`; never assumed from the browser's name. */
export function pickVoiceMime(isTypeSupported: ((type: string) => boolean) | undefined): VoiceMime {
    for (const candidate of MIME_CANDIDATES) {
        let supported = false;
        try {
            supported = !!isTypeSupported?.(candidate);
        } catch {
            supported = false;
        }
        if (supported) {
            return { recorderType: candidate, ...describeType(candidate) };
        }
    }
    return { recorderType: undefined, fileType: "audio/webm", extension: "webm" };
}

/** The file type and extension of what a recorder produced (`MediaRecorder.mimeType`). */
export function describeType(type: string): { fileType: string; extension: string } {
    const base = type.split(";")[0].trim().toLowerCase();
    if (base === "audio/mp4" || base === "video/mp4") {
        return { fileType: "audio/mp4", extension: "m4a" };
    }
    if (base === "audio/wav" || base === "audio/wave" || base === "audio/x-wav") {
        return { fileType: "audio/wav", extension: "wav" };
    }
    if (base === "audio/ogg") {
        return { fileType: "audio/ogg", extension: "ogg" };
    }
    return { fileType: "audio/webm", extension: "webm" };
}

/** Sorts a failure of `getUserMedia()` into what the person is told. */
export function classifyMicError(error: unknown): RecorderErrorCode {
    const name = (error as { name?: string } | null)?.name ?? "";
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
        return "denied";
    }
    if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
        return "no_mic";
    }
    if (name === "NotSupportedError" || name === "TypeError") {
        return "unsupported";
    }
    return "failed";
}

interface RecorderLike {
    readonly state: "inactive" | "recording" | "paused";
    readonly mimeType: string;
    start(timeslice?: number): void;
    pause(): void;
    resume(): void;
    stop(): void;
    addEventListener(type: "dataavailable", listener: (event: { data: Blob }) => void): void;
    addEventListener(type: "stop" | "error", listener: () => void): void;
}

interface RecorderConstructor {
    new (stream: MediaStream, options?: MediaRecorderOptions): RecorderLike;
    isTypeSupported?(type: string): boolean;
}

interface WakeLockLike {
    release(): Promise<void>;
}

export interface RecorderDeps {
    getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
    MediaRecorder?: RecorderConstructor;
    now?: () => number;
    document?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
    requestWakeLock?: () => Promise<WakeLockLike | null>;
}

export interface RecorderSnapshot {
    state: RecorderState;
    elapsedMs: number;
    pauseReason: PauseReason | null;
    /** Set once the recording passed {@link VOICE_WARN_MS}. */
    nearLimit: boolean;
    /** Set when the 20-minute limit stopped the recording. */
    limitReached: boolean;
    error: RecorderErrorCode | null;
}

type Listener = (snapshot: RecorderSnapshot) => void;

export class VoiceRecorder {
    private state: RecorderState = "idle";
    private pauseReason: PauseReason | null = null;
    private accumulatedMs = 0;
    private segmentStart = 0;
    private nearLimit = false;
    private limitReached = false;
    private error: RecorderErrorCode | null = null;
    private stateBeforeDiscard: "recording" | "paused" = "paused";
    private chunks: Blob[] = [];
    private recorder: RecorderLike | null = null;
    private stream: MediaStream | null = null;
    private wakeLock: WakeLockLike | null = null;
    private ticker: ReturnType<typeof setInterval> | null = null;
    private undoTimer: ReturnType<typeof setTimeout> | null = null;
    private stopWaiters: ((blob: Blob) => void)[] = [];
    private readonly listeners = new Set<Listener>();
    private readonly deps: Required<Pick<RecorderDeps, "now">> & RecorderDeps;
    mime: VoiceMime = { recorderType: undefined, fileType: "audio/webm", extension: "webm" };

    constructor(deps: RecorderDeps = {}) {
        this.deps = {
            now: () => Date.now(),
            ...deps
        };
    }

    /** The live microphone stream, for the level meter. */
    get mediaStream() {
        return this.stream;
    }

    snapshot(): RecorderSnapshot {
        return {
            state: this.state,
            elapsedMs: this.elapsedMs(),
            pauseReason: this.pauseReason,
            nearLimit: this.nearLimit,
            limitReached: this.limitReached,
            error: this.error
        };
    }

    onChange(listener: Listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    elapsedMs() {
        const running = this.state === "recording" ? this.deps.now() - this.segmentStart : 0;
        return Math.min(VOICE_MAX_MS, this.accumulatedMs + running);
    }

    async start() {
        if (this.state !== "idle" && this.state !== "failed") {
            return;
        }
        this.error = null;
        this.setState("starting");

        const getUserMedia = this.deps.getUserMedia;
        const Recorder = this.deps.MediaRecorder;
        if (!getUserMedia || !Recorder) {
            this.fail("unsupported");
            return;
        }

        let stream: MediaStream;
        try {
            stream = await getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
                video: false
            });
        } catch (e) {
            this.fail(classifyMicError(e));
            return;
        }
        // Closed or disposed while the browser asked for the microphone.
        if (this.snapshot().state !== "starting") {
            stopTracks(stream);
            return;
        }

        this.mime = pickVoiceMime(Recorder.isTypeSupported?.bind(Recorder));
        let recorder: RecorderLike;
        try {
            recorder = new Recorder(stream, {
                ...(this.mime.recorderType ? { mimeType: this.mime.recorderType } : {}),
                audioBitsPerSecond: VOICE_BITS_PER_SECOND
            });
        } catch {
            stopTracks(stream);
            this.fail("unsupported");
            return;
        }

        this.stream = stream;
        this.recorder = recorder;
        recorder.addEventListener("dataavailable", (event) => {
            if (event.data && event.data.size > 0) {
                this.chunks.push(event.data);
            }
        });
        recorder.addEventListener("stop", () => this.onRecorderStopped());
        for (const track of stream.getAudioTracks()) {
            track.addEventListener("ended", () => this.onTrackEnded());
        }
        this.deps.document?.addEventListener("visibilitychange", this.onVisibilityChange);

        recorder.start(TIMESLICE_MS);
        if (recorder.mimeType) {
            this.mime = { recorderType: this.mime.recorderType, ...describeType(recorder.mimeType) };
        }
        this.segmentStart = this.deps.now();
        this.ticker = setInterval(() => this.tick(), TICK_MS);
        void this.acquireWakeLock();
        this.setState("recording");
    }

    pause(reason: PauseReason = "user") {
        if (this.state !== "recording") {
            return;
        }
        this.accumulatedMs += this.deps.now() - this.segmentStart;
        if (this.recorder?.state === "recording") {
            this.recorder.pause();
        }
        this.pauseReason = reason;
        void this.releaseWakeLock();
        this.setState("paused");
    }

    resume() {
        if (this.state !== "paused" || this.pauseReason === "lost" || this.limitReached) {
            return;
        }
        if (this.recorder?.state === "paused") {
            this.recorder.resume();
        }
        this.pauseReason = null;
        this.segmentStart = this.deps.now();
        void this.acquireWakeLock();
        this.setState("recording");
    }

    /** Ends the recording and resolves with the audio. The microphone is released. */
    stop(): Promise<Blob> {
        if (this.state === "recording") {
            this.accumulatedMs += this.deps.now() - this.segmentStart;
        }
        if (this.state === "stopped" || this.state === "closed") {
            return Promise.resolve(this.blob());
        }
        if (this.state !== "recording" && this.state !== "paused" && this.state !== "discarded" && this.state !== "stopping") {
            return Promise.resolve(this.blob());
        }
        this.clearUndo();
        const promise = new Promise<Blob>((resolve) => this.stopWaiters.push(resolve));
        if (this.state !== "stopping") {
            this.setState("stopping");
            if (this.recorder && this.recorder.state !== "inactive") {
                this.recorder.stop();
            } else {
                this.onRecorderStopped();
            }
        }
        return promise;
    }

    /** Throws the recording away after {@link VOICE_UNDO_MS} unless `undoDiscard()` comes first. */
    discard() {
        if (this.state !== "recording" && this.state !== "paused") {
            return;
        }
        this.stateBeforeDiscard = this.state;
        if (this.state === "recording") {
            this.accumulatedMs += this.deps.now() - this.segmentStart;
            if (this.recorder?.state === "recording") {
                this.recorder.pause();
            }
        }
        void this.releaseWakeLock();
        this.setState("discarded");
        this.undoTimer = setTimeout(() => this.finishDiscard(), VOICE_UNDO_MS);
    }

    /** Brings a discarded recording back, paused, so nothing is recorded behind the person's back. */
    undoDiscard() {
        if (this.state !== "discarded") {
            return;
        }
        this.clearUndo();
        this.pauseReason = this.stateBeforeDiscard === "recording" ? "user" : this.pauseReason ?? "user";
        this.setState("paused");
    }

    /** Releases everything at once (the bar was closed after a failure, or the page goes away). */
    dispose() {
        this.clearUndo();
        this.teardown();
        this.chunks = [];
        if (this.state !== "closed") {
            this.setState("closed");
        }
    }

    blob() {
        return new Blob(this.chunks, { type: this.mime.fileType });
    }

    private finishDiscard() {
        this.undoTimer = null;
        if (this.recorder && this.recorder.state !== "inactive") {
            try {
                this.recorder.stop();
            } catch {
                // Already stopped by the browser.
            }
        }
        this.teardown();
        this.chunks = [];
        this.setState("closed");
    }

    private onRecorderStopped() {
        if (this.state === "stopping") {
            this.teardown();
            this.setState("stopped");
            const blob = this.blob();
            for (const waiter of this.stopWaiters.splice(0)) {
                waiter(blob);
            }
        } else if (this.state === "recording" || this.state === "paused") {
            // The browser ended the recorder itself, as when the microphone's track ends.
            this.onTrackEnded();
        }
    }

    private onTrackEnded() {
        if (this.state === "recording") {
            this.pause("lost");
        } else if (this.state === "paused") {
            this.pauseReason = "lost";
            this.emit();
        }
    }

    private readonly onVisibilityChange = () => {
        if (this.deps.document?.visibilityState === "hidden" && this.state === "recording") {
            this.pause("hidden");
        }
    };

    private tick() {
        if (this.state !== "recording") {
            return;
        }
        const elapsed = this.elapsedMs();
        if (elapsed >= VOICE_MAX_MS) {
            this.limitReached = true;
            void this.stop();
            return;
        }
        if (!this.nearLimit && elapsed >= VOICE_WARN_MS) {
            this.nearLimit = true;
        }
        this.emit();
    }

    private fail(code: RecorderErrorCode) {
        this.error = code;
        this.teardown();
        this.setState("failed");
    }

    private teardown() {
        if (this.ticker) {
            clearInterval(this.ticker);
            this.ticker = null;
        }
        this.deps.document?.removeEventListener("visibilitychange", this.onVisibilityChange);
        if (this.stream) {
            stopTracks(this.stream);
            this.stream = null;
        }
        void this.releaseWakeLock();
    }

    private clearUndo() {
        if (this.undoTimer) {
            clearTimeout(this.undoTimer);
            this.undoTimer = null;
        }
    }

    private async acquireWakeLock() {
        if (this.wakeLock || !this.deps.requestWakeLock) {
            return;
        }
        try {
            this.wakeLock = await this.deps.requestWakeLock();
        } catch {
            this.wakeLock = null;
        }
    }

    private async releaseWakeLock() {
        const lock = this.wakeLock;
        this.wakeLock = null;
        try {
            await lock?.release();
        } catch {
            // Released by the browser already.
        }
    }

    private setState(state: RecorderState) {
        this.state = state;
        this.emit();
    }

    private emit() {
        const snapshot = this.snapshot();
        for (const listener of this.listeners) {
            listener(snapshot);
        }
    }
}

function stopTracks(stream: MediaStream) {
    for (const track of stream.getTracks()) {
        track.stop();
    }
}

/** `mm:ss` of a duration. */
export function formatElapsed(ms: number) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** The browser's recorder and microphone, or nothing where the page cannot record. */
export function browserRecorderDeps(): RecorderDeps {
    const mediaDevices = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    const wakeLock = typeof navigator !== "undefined"
        ? (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<WakeLockLike> } }).wakeLock
        : undefined;
    return {
        getUserMedia: mediaDevices?.getUserMedia ? (constraints) => mediaDevices.getUserMedia(constraints) : undefined,
        MediaRecorder: typeof MediaRecorder !== "undefined" ? MediaRecorder as unknown as RecorderConstructor : undefined,
        document: typeof document !== "undefined" ? document : undefined,
        requestWakeLock: wakeLock ? () => wakeLock.request("screen") : undefined
    };
}
