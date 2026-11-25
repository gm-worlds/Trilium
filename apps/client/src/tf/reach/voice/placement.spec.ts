import { describe, expect, it, vi } from "vitest";

import { TfGatewayError } from "../../gateway.js";
import { decideEmbedPlacement, insertAfterAttachmentEmbed, recordingFileName, transcriptHtml } from "./placement.js";
import { isTooLongForTranscript, outcomeFromError, requestTranscript, routeTypeOf, withFullStop } from "./transcribe.js";

describe("voice note placement", () => {
    it("puts the embed at the start caret, at the end when that block is gone, or reopens the note", () => {
        const base = { editorAlive: true, editorNoteId: "n1", noteId: "n1" };
        expect(decideEmbedPlacement({ ...base, markerRoot: "main" })).toBe("marker");
        expect(decideEmbedPlacement({ ...base, markerRoot: "$graveyard" })).toBe("end");
        expect(decideEmbedPlacement({ ...base, markerRoot: null })).toBe("end");
        expect(decideEmbedPlacement({ ...base, editorNoteId: "n2", markerRoot: "main" })).toBe("reopen");
        expect(decideEmbedPlacement({ ...base, editorAlive: false, markerRoot: "main" })).toBe("reopen");
    });

    it("writes the transcript as an escaped collapsible block, or a block quote without one", () => {
        const html = transcriptHtml("Hello <b>you</b> & me\n\nSecond line", "Transcript", true);
        expect(html).toBe(
            "<details class=\"trilium-collapsible\" open=\"\"><summary>Transcript</summary>"
            + "<p>Hello &lt;b&gt;you&lt;/b&gt; &amp; me</p><p>Second line</p></details>");
        expect(transcriptHtml("One", "T", false)).toBe("<blockquote><p>One</p></blockquote>");
        expect(transcriptHtml("   ", "T", false)).toBe("<blockquote><p></p></blockquote>");
    });

    it("puts the transcript right after the attachment's embed in saved HTML, else at the end", () => {
        const note = "<p>a</p><figure class=\"include-note\" data-attachment-id=\"att1\" data-box-size=\"compact\"><figure>x</figure><figcaption>c</figcaption></figure><p>b</p>";
        expect(insertAfterAttachmentEmbed(note, "att1", "<p>T</p>"))
            .toBe("<p>a</p><figure class=\"include-note\" data-attachment-id=\"att1\" data-box-size=\"compact\"><figure>x</figure><figcaption>c</figcaption></figure><p>T</p><p>b</p>");
        expect(insertAfterAttachmentEmbed("<p>a</p>", "att1", "<p>T</p>")).toBe("<p>a</p><p>T</p>");
        expect(insertAfterAttachmentEmbed("<section class=\"include-note\" data-attachment-id=\"att2\"></section>", "att2", "!"))
            .toBe("<section class=\"include-note\" data-attachment-id=\"att2\"></section>!");
    });

    it("names a recording after its local start time", () => {
        expect(recordingFileName(new Date(2026, 10, 25, 9, 3, 7), "webm", "Voice note")).toBe("Voice note 2026-11-25 09-03-07.webm");
    });
});

describe("transcript route", () => {
    it("sorts the route's answers", () => {
        expect(outcomeFromError(429, { error: "ai_budget_used_up", message: "Used up until 1 December" }))
            .toEqual({ ok: false, kind: "budget", message: "Used up until 1 December" });
        expect(outcomeFromError(503, { error: "ai_not_configured" })).toMatchObject({ kind: "not_configured" });
        expect(outcomeFromError(413, {})).toMatchObject({ kind: "too_long" });
        expect(outcomeFromError(415, { message: "WebM only" })).toEqual({ ok: false, kind: "unsupported", message: "WebM only" });
        expect(outcomeFromError(502, null)).toMatchObject({ kind: "failed", message: null });
        expect(withFullStop("Used up until 1 December")).toBe("Used up until 1 December.");
        expect(withFullStop("Done.")).toBe("Done.");
    });

    it("sends only what the route takes, with the type without codecs", async () => {
        expect(routeTypeOf("audio/webm;codecs=opus")).toBe("audio/webm");
        expect(routeTypeOf("audio/x-m4a")).toBe("audio/mp4");
        expect(routeTypeOf("audio/mpeg")).toBeNull();
        expect(isTooLongForTranscript(26 * 1024 * 1024, null)).toBe(true);
        expect(isTooLongForTranscript(1000, 20 * 60 + 5)).toBe(true);
        expect(isTooLongForTranscript(1000, 20 * 60)).toBe(false);
        expect(isTooLongForTranscript(1000, Number.POSITIVE_INFINITY)).toBe(false);

        const fetchImpl = vi.fn(async () => ({ text: "hi", language: "en", seconds: 3 }));
        const ok = await requestTranscript(new Blob([ "x" ]), "audio/webm;codecs=opus", fetchImpl as never);
        expect(ok).toEqual({ ok: true, transcript: { text: "hi", language: "en", seconds: 3 } });
        expect(fetchImpl).toHaveBeenCalledWith("voice/transcribe", expect.objectContaining({
            method: "POST", headers: { "Content-Type": "audio/webm" }
        }));

        const refused = vi.fn(async () => {
            throw new TfGatewayError(429, { error: "ai_budget_used_up", message: "Budget used up." });
        });
        expect(await requestTranscript(new Blob([ "x" ]), "audio/mp4", refused as never))
            .toEqual({ ok: false, kind: "budget", message: "Budget used up." });
        expect(await requestTranscript(new Blob([ "x" ]), "audio/mpeg", fetchImpl as never)).toMatchObject({ kind: "unsupported" });
    });
});
