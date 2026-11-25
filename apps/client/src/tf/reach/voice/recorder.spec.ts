import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyMicError, describeType, formatElapsed, pickVoiceMime, VOICE_MAX_MS, VOICE_UNDO_MS, VOICE_WARN_MS, VoiceRecorder } from "./recorder.js";

class FakeTrack extends EventTarget {
    stopped = false;
    stop() {
        this.stopped = true;
    }
}

function fakeStream() {
    const track = new FakeTrack();
    const stream = {
        getAudioTracks: () => [ track ],
        getTracks: () => [ track ]
    } as unknown as MediaStream;
    return { stream, track };
}

class FakeRecorder {
    static supported = new Set([ "audio/webm;codecs=opus" ]);
    static last: FakeRecorder | null = null;
    static isTypeSupported(type: string) {
        return FakeRecorder.supported.has(type);
    }
    state: "inactive" | "recording" | "paused" = "inactive";
    mimeType: string;
    private readonly target = new EventTarget();
    private readonly handlers: { type: string; listener: (event: { data: Blob }) => void }[] = [];
    constructor(_stream: MediaStream, readonly options: MediaRecorderOptions = {}) {
        this.mimeType = options.mimeType ?? "audio/webm";
        FakeRecorder.last = this;
    }
    addEventListener(type: string, listener: (event: { data: Blob }) => void) {
        this.handlers.push({ type, listener });
    }
    fire(type: string, data?: Blob) {
        for (const handler of this.handlers.filter((h) => h.type === type)) {
            handler.listener({ data: data ?? new Blob() });
        }
    }
    start() {
        this.state = "recording";
        this.fire("dataavailable", new Blob([ "a" ]));
    }
    pause() {
        this.state = "paused";
    }
    resume() {
        this.state = "recording";
    }
    stop() {
        this.state = "inactive";
        this.fire("dataavailable", new Blob([ "bc" ]));
        this.fire("stop");
    }
}

function fakeDocument() {
    const target = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
    target.visibilityState = "visible";
    return target;
}

function makeRecorder(overrides: Partial<ConstructorParameters<typeof VoiceRecorder>[0]> = {}) {
    const { stream, track } = fakeStream();
    const doc = fakeDocument();
    const release = vi.fn(async () => {});
    const recorder = new VoiceRecorder({
        getUserMedia: vi.fn(async () => stream),
        MediaRecorder: FakeRecorder as never,
        now: () => Date.now(),
        document: doc as never,
        requestWakeLock: async () => ({ release }),
        ...overrides
    });
    return { recorder, track, doc, release };
}

describe("voice mime choice", () => {
    it("asks isTypeSupported and takes the first type the route accepts", () => {
        const table: [string[], string | undefined, string, string][] = [
            [ [ "audio/webm;codecs=opus", "audio/mp4" ], "audio/webm;codecs=opus", "audio/webm", "webm" ],
            [ [ "audio/mp4" ], "audio/mp4", "audio/mp4", "m4a" ],
            [ [ "audio/mp4;codecs=mp4a.40.2", "audio/mp4" ], "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "m4a" ],
            [ [ "audio/webm" ], "audio/webm", "audio/webm", "webm" ],
            [ [], undefined, "audio/webm", "webm" ]
        ];
        for (const [ supported, recorderType, fileType, extension ] of table) {
            const mime = pickVoiceMime((type) => supported.includes(type));
            expect(mime, supported.join(",")).toEqual({ recorderType, fileType, extension });
        }
        expect(pickVoiceMime(undefined).recorderType).toBeUndefined();
        expect(pickVoiceMime(() => {
            throw new Error("nope");
        }).recorderType).toBeUndefined();
        expect(describeType("audio/mp4;codecs=opus")).toEqual({ fileType: "audio/mp4", extension: "m4a" });
    });

    it("sorts microphone failures into what the person is told", () => {
        expect(classifyMicError({ name: "NotAllowedError" })).toBe("denied");
        expect(classifyMicError({ name: "SecurityError" })).toBe("denied");
        expect(classifyMicError({ name: "NotFoundError" })).toBe("no_mic");
        expect(classifyMicError({ name: "NotSupportedError" })).toBe("unsupported");
        expect(classifyMicError(new Error("x"))).toBe("failed");
        expect(formatElapsed(65_400)).toBe("01:05");
    });
});

describe("voice recorder", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeRecorder.supported = new Set([ "audio/webm;codecs=opus" ]);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("records mono at 32 kbps, pauses, resumes and counts only recorded time", async () => {
        const { recorder, release } = makeRecorder();
        await recorder.start();
        expect(recorder.snapshot().state).toBe("recording");
        expect(FakeRecorder.last?.options).toEqual({ mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 32_000 });

        vi.advanceTimersByTime(3000);
        expect(recorder.snapshot().elapsedMs).toBe(3000);
        recorder.pause();
        expect(recorder.snapshot()).toMatchObject({ state: "paused", pauseReason: "user" });
        expect(FakeRecorder.last?.state).toBe("paused");
        await Promise.resolve();
        expect(release).toHaveBeenCalled();
        vi.advanceTimersByTime(10_000);
        expect(recorder.snapshot().elapsedMs).toBe(3000);
        recorder.resume();
        vi.advanceTimersByTime(2000);
        expect(recorder.snapshot()).toMatchObject({ state: "recording", elapsedMs: 5000 });
    });

    it("lets go of a microphone granted after the bar was closed", async () => {
        const { stream, track } = fakeStream();
        let grant: (s: MediaStream) => void = () => {};
        const { recorder } = makeRecorder({ getUserMedia: () => new Promise<MediaStream>((resolve) => (grant = resolve)) });
        const starting = recorder.start();
        recorder.dispose();
        grant(stream as unknown as MediaStream);
        await starting;
        expect(recorder.snapshot().state).toBe("closed");
        expect(track.stopped).toBe(true);
    });

    it("stops with the whole audio and lets go of the microphone", async () => {
        const { recorder, track } = makeRecorder();
        await recorder.start();
        vi.advanceTimersByTime(1500);
        const blob = await recorder.stop();
        expect(recorder.snapshot().state).toBe("stopped");
        expect(blob.size).toBe(3);
        expect(blob.type).toBe("audio/webm");
        expect(track.stopped).toBe(true);
    });

    it("discards with five seconds to undo, then throws the audio away", async () => {
        const { recorder, track } = makeRecorder();
        await recorder.start();
        vi.advanceTimersByTime(2000);
        recorder.discard();
        expect(recorder.snapshot().state).toBe("discarded");
        expect(FakeRecorder.last?.state).toBe("paused");
        vi.advanceTimersByTime(VOICE_UNDO_MS - 100);
        recorder.undoDiscard();
        expect(recorder.snapshot()).toMatchObject({ state: "paused", elapsedMs: 2000 });
        expect(track.stopped).toBe(false);

        recorder.discard();
        vi.advanceTimersByTime(VOICE_UNDO_MS);
        expect(recorder.snapshot().state).toBe("closed");
        expect(track.stopped).toBe(true);
        expect(recorder.blob().size).toBe(0);
        recorder.undoDiscard();
        expect(recorder.snapshot().state).toBe("closed");
    });

    it("warns at 19:00 and stops by itself at 20:00", async () => {
        const { recorder } = makeRecorder();
        const states: string[] = [];
        recorder.onChange((s) => states.push(s.state));
        await recorder.start();
        vi.advanceTimersByTime(VOICE_WARN_MS - 1000);
        expect(recorder.snapshot().nearLimit).toBe(false);
        vi.advanceTimersByTime(1000);
        expect(recorder.snapshot().nearLimit).toBe(true);
        vi.advanceTimersByTime(VOICE_MAX_MS - VOICE_WARN_MS);
        expect(recorder.snapshot()).toMatchObject({ state: "stopped", limitReached: true, elapsedMs: VOICE_MAX_MS });
        expect(states).toContain("stopping");
        recorder.resume();
        expect(recorder.snapshot().state).toBe("stopped");
    });

    it("pauses while the page is hidden and when the microphone goes away", async () => {
        const { recorder, doc, track } = makeRecorder();
        await recorder.start();
        doc.visibilityState = "hidden";
        doc.dispatchEvent(new Event("visibilitychange"));
        expect(recorder.snapshot()).toMatchObject({ state: "paused", pauseReason: "hidden" });
        doc.visibilityState = "visible";
        recorder.resume();
        expect(recorder.snapshot().state).toBe("recording");

        track.dispatchEvent(new Event("ended"));
        expect(recorder.snapshot()).toMatchObject({ state: "paused", pauseReason: "lost" });
        recorder.resume();
        expect(recorder.snapshot().state).toBe("paused");
        const blob = await recorder.stop();
        expect(blob.size).toBeGreaterThan(0);
    });

    it("says why it cannot start: denied, no microphone, no recorder", async () => {
        const denied = makeRecorder({ getUserMedia: async () => {
            throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
        } });
        await denied.recorder.start();
        expect(denied.recorder.snapshot()).toMatchObject({ state: "failed", error: "denied" });

        const missing = makeRecorder({ getUserMedia: async () => {
            throw Object.assign(new Error("none"), { name: "NotFoundError" });
        } });
        await missing.recorder.start();
        expect(missing.recorder.snapshot().error).toBe("no_mic");

        const none = makeRecorder({ MediaRecorder: undefined });
        await none.recorder.start();
        expect(none.recorder.snapshot().error).toBe("unsupported");
    });
});
