import { render } from "preact";
import { act } from "preact/test-utils";
import { describe, expect, it } from "vitest";

import { meterAnimates } from "./level_meter.js";
import { announcementFor, spokenDuration, useSessionView } from "./RecorderBar.js";
import type { VoiceView } from "./session.js";

function Probe({ session }: { session: Parameters<typeof useSessionView>[0] }) {
    return <span>{useSessionView(session).phase}</span>;
}

describe("the recorder bar's view of its session", () => {
    it("shows a change that comes before the bar subscribes, as a denied microphone does", async () => {
        const listeners = new Set<() => void>();
        const session = {
            view: { phase: "recorder" } as VoiceView,
            subscribe(listener: () => void) {
                listeners.add(listener);
                return () => listeners.delete(listener);
            }
        };
        const host = document.createElement("div");
        render(<Probe session={session} />, host);
        session.view = { ...session.view, phase: "mic_error" };
        for (const listener of listeners) listener();

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(host.textContent).toBe("mic_error");
        act(() => render(null, host));
    });
});

describe("what the recorder bar says and shows", () => {
    const view = (phase: VoiceView["phase"], state: string) => ({ phase, snapshot: { state } }) as Pick<VoiceView, "phase" | "snapshot">;

    it("announces state changes only, never the clock", () => {
        expect(announcementFor(view("recorder", "idle"))).toBe("tf.reach.starting");
        expect(announcementFor(view("recorder", "recording"))).toBe("tf.reach.recording");
        expect(announcementFor(view("recorder", "paused"))).toBe("tf.reach.paused");
        expect(announcementFor(view("recorder", "discarded"))).toBe("tf.reach.discarded");
        expect(announcementFor(view("saving", "stopped"))).toBe("tf.reach.saving");
        expect(announcementFor(view("mic_error", "idle"))).toBeNull();
    });

    it("says the length of a recording in words, in the person's language", () => {
        expect(spokenDuration(65_400, "en")).toBe("1 minute and 5 seconds");
        expect(spokenDuration(120_000, "en")).toBe("2 minutes");
        expect(spokenDuration(1_000, "en")).toBe("1 second");
        expect(spokenDuration(65_000, "nl")).toBe("1 minuut en 5 seconden");
    });

    it("moves the level meter only with motion allowed and the tab shown", () => {
        expect(meterAnimates({ reducedMotion: false, motionDisabled: false, hidden: false })).toBe(true);
        expect(meterAnimates({ reducedMotion: true, motionDisabled: false, hidden: false })).toBe(false);
        expect(meterAnimates({ reducedMotion: false, motionDisabled: true, hidden: false })).toBe(false);
        expect(meterAnimates({ reducedMotion: false, motionDisabled: false, hidden: true })).toBe(false);
    });
});
