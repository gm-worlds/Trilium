/**
 * The bar of a running voice note, docked at the bottom of the note (on a phone right above the
 * formatting toolbar and the keyboard), never a modal: the note stays usable while it records.
 * Screen readers hear state changes only; the clock is in the bar's name, not in a live region.
 */
import "./RecorderBar.css";

import { useSyncExternalStore } from "preact/compat";
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";

import { t } from "../../../services/i18n.js";
import ActionButton from "../../../widgets/react/ActionButton.js";
import Button from "../../../widgets/react/Button.js";
import { formatPercent } from "../../mobile/gestures.js";
import { revealFocus } from "../../mobile/keyboard.js";
import { TF_VIEWPORT_EVENT } from "../../theme.js";
import { LevelMeter } from "./level_meter.js";
import { formatElapsed } from "./recorder.js";
import type { VoiceSession, VoiceView } from "./session.js";

export default function RecorderBar({ session }: { session: VoiceSession }) {
    const view = useSessionView(session);
    const barRef = useRef<HTMLDivElement>(null);
    useDockedPosition(barRef, session);
    useAnnouncements(view);
    useFocusBackOnClose(barRef, session);

    const elapsed = view.phase === "recorder" || view.phase === "saving"
        ? t("tf.reach.recorder_time", { time: spokenDuration(view.snapshot.elapsedMs, document.documentElement.lang || undefined) })
        : t("tf.reach.recorder");

    return (
        <div
            ref={barRef}
            className={`tf-voice-bar phase-${view.phase} state-${view.snapshot.state}`}
            role="region"
            aria-label={elapsed}
            onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                e.stopPropagation();
                if (view.phase === "save_failed" || view.phase === "mic_error") {
                    session.close();
                }
                focusEditor(session);
            }}
        >
            {view.phase === "recorder" && <RecorderControls session={session} view={view} />}
            {view.phase === "saving" && <SavingRow view={view} />}
            {view.phase === "save_failed" && <SaveFailedRow session={session} view={view} />}
            {view.phase === "mic_error" && <MicErrorRow session={session} view={view} />}
        </div>
    );
}

function RecorderControls({ session, view }: { session: VoiceSession; view: VoiceView }) {
    const { snapshot } = view;
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const meterRef = useRef<LevelMeter | null>(null);
    const stream = session.recorder.mediaStream;
    const recording = snapshot.state === "recording";

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const meter = new LevelMeter(canvas);
        meterRef.current = meter;
        return () => {
            meter.dispose();
            meterRef.current = null;
        };
    }, []);

    useEffect(() => {
        meterRef.current?.attach(stream);
    }, [ stream ]);

    useEffect(() => {
        meterRef.current?.setRunning(recording);
    }, [ recording ]);

    if (snapshot.state === "discarded") {
        return (
            <div className="tf-voice-row">
                <span className="tf-voice-message">{t("tf.reach.discarded")}</span>
                <Button className="tf-voice-undo" text={t("tf.reach.undo")} icon="bx bx-undo" onClick={() => session.recorder.undoDiscard()} />
            </div>
        );
    }

    const notice = snapshot.pauseReason === "hidden"
        ? t("tf.reach.paused_hidden")
        : snapshot.pauseReason === "lost"
            ? t("tf.reach.paused_lost")
            : snapshot.nearLimit
                ? t("tf.reach.one_minute_left")
                : null;
    const starting = isStarting(view);
    const label = starting ? t("tf.reach.starting") : recording ? t("tf.reach.recording") : t("tf.reach.paused");

    return (
        <>
            <div className="tf-voice-row">
                <span className={`tf-voice-dot ${recording ? "on" : ""}`} aria-hidden="true" />
                <span className="tf-voice-status">
                    <span className="tf-voice-label">{label}</span>
                    <span className="tf-voice-time" aria-hidden="true">{formatElapsed(snapshot.elapsedMs)}</span>
                </span>
                <canvas ref={canvasRef} className="tf-voice-level" aria-hidden="true" />
                <div className="tf-voice-actions">
                    {recording
                        ? <ActionButton className="tf-voice-pause" icon="bx bx-pause" text={t("tf.reach.pause")} onClick={() => session.recorder.pause()} />
                        : <ActionButton className="tf-voice-resume" icon="bx bx-play" text={t("tf.reach.resume")}
                            disabled={starting || snapshot.pauseReason === "lost"} onClick={() => session.recorder.resume()} />}
                    <ActionButton className="tf-voice-discard" icon="bx bx-trash" text={t("tf.reach.discard")}
                        disabled={starting} onClick={() => session.recorder.discard()} />
                    <Button className="tf-voice-stop" kind="primary" icon="bx bx-stop" text={t("tf.reach.stop")}
                        disabled={starting} onClick={() => session.stop()} />
                </div>
            </div>
            {notice && <div className="tf-voice-notice" role="alert">{notice}</div>}
        </>
    );
}

function SavingRow({ view }: { view: VoiceView }) {
    const text = view.percent > 0 && view.percent < 100
        ? t("tf.reach.saving_percent", { percent: formatPercent(view.percent / 100, document.documentElement.lang || undefined) })
        : t("tf.reach.saving");
    return (
        <>
            <div className="tf-voice-row">
                <span className="bx bx-loader-alt bx-spin tf-voice-spinner" aria-hidden="true" />
                <span className="tf-voice-message">{text}</span>
                <span className="tf-voice-time" aria-hidden="true">{formatElapsed(view.snapshot.elapsedMs)}</span>
            </div>
            {view.snapshot.limitReached && <div className="tf-voice-notice" role="alert">{t("tf.reach.limit_reached")}</div>}
        </>
    );
}

function SaveFailedRow({ session, view }: { session: VoiceSession; view: VoiceView }) {
    return (
        <div className="tf-voice-row wrap">
            <span className="tf-voice-message" role="alert">{view.message}</span>
            <div className="tf-voice-actions">
                {view.downloadUrl && (
                    <Button className="tf-voice-download" icon="bx bx-download" text={t("tf.reach.download")}
                        onClick={() => downloadFile(view.downloadUrl ?? "", view.downloadName ?? "voice-note")} />
                )}
                <ActionButton className="tf-voice-close" icon="bx bx-x" text={t("tf.reach.close")} onClick={() => session.close()} />
                <Button className="tf-voice-retry" kind="primary" text={t("tf.reach.try_again")} onClick={() => void session.retrySave()} />
            </div>
        </div>
    );
}

function MicErrorRow({ session, view }: { session: VoiceSession; view: VoiceView }) {
    return (
        <div className="tf-voice-row wrap">
            <span className="bx bx-microphone-off tf-voice-error-icon" aria-hidden="true" />
            <span className="tf-voice-message" role="alert">{view.message}</span>
            <div className="tf-voice-actions">
                <ActionButton className="tf-voice-close" icon="bx bx-x" text={t("tf.reach.close")} onClick={() => session.close()} />
                <Button className="tf-voice-retry" text={t("tf.reach.try_again")} onClick={() => void session.retryMicrophone()} />
            </div>
        </div>
    );
}

function downloadFile(url: string, name: string) {
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
}

/** The session's view, read again on subscribing, so a failure that comes before then is shown. */
export function useSessionView(session: Pick<VoiceSession, "subscribe" | "view">) {
    return useSyncExternalStore((listener) => session.subscribe(listener), () => session.view);
}

/**
 * Keeps the bar fixed at the bottom of the note's pane, above the phone's formatting toolbar, as
 * the visible area, the pane or the toolbar change. The keyboard inset and the safe areas join in
 * CSS (`RecorderBar.css`). On touch the caret is kept above the bar once it shows.
 */
function useDockedPosition(barRef: { current: HTMLDivElement | null }, session: VoiceSession) {
    useLayoutEffect(() => {
        let frame = 0;
        const place = () => {
            frame = 0;
            const bar = barRef.current;
            if (!bar) return;
            const box = dockBox(session);
            bar.style.setProperty("--tf-voice-left", `${box.left}px`);
            bar.style.setProperty("--tf-voice-width", `${box.width}px`);
            bar.style.setProperty("--tf-voice-bottom", `${box.bottom}px`);
        };
        const schedule = () => {
            frame ||= requestAnimationFrame(place);
        };
        place();

        const viewport = window.visualViewport;
        const windowEvents = [ "resize", TF_VIEWPORT_EVENT ];
        const documentEvents = [ "focusin", "focusout", "transitionend" ];
        viewport?.addEventListener("resize", schedule);
        viewport?.addEventListener("scroll", schedule);
        for (const type of windowEvents) window.addEventListener(type, schedule);
        for (const type of documentEvents) document.addEventListener(type, schedule, true);
        const observer = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
        const pane = paneOf(session);
        if (pane) observer?.observe(pane);
        for (const island of document.querySelectorAll(".classic-toolbar-island")) observer?.observe(island);

        if (document.documentElement.classList.contains("tf-touch")) {
            requestAnimationFrame(() => revealFocus());
        }
        return () => {
            cancelAnimationFrame(frame);
            viewport?.removeEventListener("resize", schedule);
            viewport?.removeEventListener("scroll", schedule);
            for (const type of windowEvents) window.removeEventListener(type, schedule);
            for (const type of documentEvents) document.removeEventListener(type, schedule, true);
            observer?.disconnect();
        };
    }, [ session ]);
}

/** The bar is not modal: Escape and its closing hand the focus back to the note. */
function useFocusBackOnClose(barRef: { current: HTMLDivElement | null }, session: VoiceSession) {
    useLayoutEffect(() => {
        const bar = barRef.current;
        return () => {
            if (bar?.contains(document.activeElement)) {
                focusEditor(session);
            }
        };
    }, [ session ]);
}

function focusEditor(session: VoiceSession) {
    if (session.editor.state !== "destroyed") {
        session.editor.editing.view.focus();
    }
}

/**
 * Says what the recorder is doing through one polite live region that outlives the bar: a state
 * change, never the running clock, and "Recording saved." once a save closes the bar.
 */
function useAnnouncements(view: VoiceView) {
    const message = announcementFor(view);
    const lastPhase = useRef(view.phase);
    lastPhase.current = view.phase;

    useEffect(() => {
        if (message) announce(t(message));
    }, [ message ]);

    useLayoutEffect(() => () => {
        if (lastPhase.current === "saving") announce(t("tf.reach.saved"));
    }, []);
}

/** The key of what a screen reader hears for `view`; `null` where an alert speaks instead. */
export function announcementFor(view: Pick<VoiceView, "phase" | "snapshot">): string | null {
    if (view.phase === "saving") return "tf.reach.saving";
    if (view.phase !== "recorder") return null;
    if (view.snapshot.state === "discarded") return "tf.reach.discarded";
    if (isStarting(view)) return "tf.reach.starting";
    return view.snapshot.state === "recording" ? "tf.reach.recording" : "tf.reach.paused";
}

function isStarting(view: Pick<VoiceView, "snapshot">) {
    return view.snapshot.state === "starting" || view.snapshot.state === "idle";
}

let announcer: HTMLElement | null = null;

function announce(text: string) {
    if (!announcer?.isConnected) {
        announcer = document.createElement("div");
        announcer.className = "visually-hidden tf-voice-announcer";
        announcer.setAttribute("role", "status");
        announcer.setAttribute("aria-live", "polite");
        document.body.append(announcer);
    }
    announcer.textContent = text;
}

/** A recording's length the way it is said: "1 minute and 5 seconds", in `locale`. */
export function spokenDuration(ms: number, locale?: string) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    const unit = (value: number, name: "minute" | "second") =>
        new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "long" }).format(value);
    const parts = minutes ? [ unit(minutes, "minute"), ...(seconds ? [ unit(seconds, "second") ] : []) ] : [ unit(seconds, "second") ];
    return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts);
}

function paneOf(session: VoiceSession) {
    const editable = session.editor.state !== "destroyed" ? session.editor.ui.view.editable?.element : null;
    return editable?.closest<HTMLElement>(".note-split") ?? editable?.closest<HTMLElement>(".scrolling-container") ?? null;
}

const GUTTER = 12;
const MAX_WIDTH = 640;

function dockBox(session: VoiceSession) {
    const viewport = window.visualViewport;
    const visibleBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
    const pane = paneOf(session);
    const paneBox = pane?.isConnected ? pane.getBoundingClientRect() : null;
    const left = paneBox ? Math.max(0, paneBox.left) : 0;
    const right = paneBox ? Math.min(window.innerWidth, paneBox.right) : window.innerWidth;
    const width = Math.min(MAX_WIDTH, right - left - GUTTER * 2);
    const centredLeft = left + (right - left - width) / 2;

    let floor = Math.min(visibleBottom, paneBox ? paneBox.bottom : visibleBottom);
    const island = document.querySelector<HTMLElement>(".classic-toolbar-outer-container.active .classic-toolbar-island");
    if (island && island.offsetParent !== null) {
        floor = Math.min(floor, island.getBoundingClientRect().top);
    }
    return {
        left: Math.round(centredLeft),
        width: Math.round(Math.max(200, width)),
        bottom: Math.round(Math.max(0, window.innerHeight - floor) + GUTTER)
    };
}
