/**
 * Start of the Taskforce embedding on the client. Loaded lazily by `maybeStartTf()` only when the
 * page runs in a frame, and active only when the engine answers `GET /api/tf/bootstrap`.
 */
import appContext from "../components/app_context.js";
import Component from "../components/component.js";
import froca from "../services/froca.js";
import server, { setTfCallInterceptor } from "../services/server.js";
import { getCapabilities, setTfBridge, TfBridge } from "./bridge.js";
import { installLinkCapture, installShortcutCapture, type TfShortcut } from "./capture.js";
import { applySessionRefresh } from "./gateway.js";
import { uninstallTfHistory } from "./history.js";
import { installTfMobile } from "./mobile/index.js";
import { installTfReach } from "./reach/index.js";
import { tfCallInterceptor } from "./save_guard.js";
import { setTfBootstrap, type TfBootstrap } from "./state.js";
import { releaseTfTeamEditors } from "./team/hooks.js";
import { installTfTeam, installTfTeamGoto } from "./team/index.js";
import { applyHostTheme, applyViewport, type TfHostTheme, type TfViewport } from "./theme.js";
import { addTfTranslations } from "./translations.js";
import { settleTfWork } from "./work/editor_host.js";
import { registerTfWorkCapabilities, setTfWorkInit, startTfWork } from "./work/index.js";

export interface TfInitParams {
    user?: unknown;
    theme?: Partial<TfHostTheme>;
    viewport?: Partial<TfViewport>;
    shortcuts?: TfShortcut[];
    tabName?: string;
    projectName?: string;
    locale?: string;
    canCreateTasks?: boolean;
}

export interface TfNoteParams {
    noteId: string;
    title: string;
    type: string;
    path: string[];
    blockId?: string;
}

const NOTE_REPORT_DEBOUNCE_MS = 200;

let started = false;
let shortcuts: TfShortcut[] = [];

export async function startTf() {
    if (started) {
        return;
    }
    started = true;

    let bootstrap: TfBootstrap | null = null;
    try {
        bootstrap = await server.getWithSilentNotFound<TfBootstrap>("tf/bootstrap");
    } catch {
        bootstrap = null;
    }
    if (!bootstrap?.embed) {
        uninstallTfHistory();
        releaseTfTeamEditors();
        settleTfWork(null);
        return;
    }

    addTfTranslations();
    setTfCallInterceptor(tfCallInterceptor);

    installTfMobile();
    installTfReach();
    installTfTeam(bootstrap);
    registerTfWorkCapabilities();

    const bridge = new TfBridge({ notebookId: bootstrap.notebookId, parentOrigins: bootstrap.parentOrigins });
    setTfBridge(bridge);
    bridge.notify("ready", { engineVersion: bootstrap.engineVersion, capabilities: getCapabilities() });

    bridge.on("init", async (params: TfInitParams) => {
        shortcuts = Array.isArray(params.shortcuts) ? params.shortcuts : [];
        setTfWorkInit(params);
        if (params.viewport) {
            applyViewport(params.viewport);
        }
        if (params.theme) {
            await applyHostTheme(params.theme);
        }
        return {};
    });
    bridge.on("theme", (params: Partial<TfHostTheme>) => applyHostTheme(params));
    bridge.on("viewport", (params: Partial<TfViewport>) => applyViewport(params));
    bridge.on("goto", (params: { noteId?: string; blockId?: string }) => gotoNote(params));
    installTfTeamGoto(bridge, gotoNote);
    bridge.on("session.refresh", (params: { token?: string }) => applySessionRefresh(String(params.token ?? "")));
    bridge.on("focus", () => focusEditor());

    setTfBootstrap(bootstrap);
    startTfWork(bootstrap);

    const reporter = new TfNoteReporter((note) => bridge.notify("note", note));
    appContext.child(reporter);
    reporter.schedule();

    installLinkCapture(bootstrap.parentOrigins, (href) => bridge.notify("open", { href }));
    installShortcutCapture(() => shortcuts, (shortcut) => bridge.notify("shortcut", shortcut));
    installFullscreenBridge((on) => bridge.notify("fullscreen", { on }));

    void bridge.connect();
}

/** Reports the active note to the host whenever it changes, debounced. */
export class TfNoteReporter extends Component {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private lastSent = "";

    constructor(private readonly send: (note: TfNoteParams) => void) {
        super();
    }

    activeContextChangedEvent() {
        this.schedule();
    }

    noteSwitchedAndActivatedEvent() {
        this.schedule();
    }

    noteSwitchedEvent() {
        this.schedule();
    }

    entitiesReloadedEvent() {
        this.schedule();
    }

    schedule() {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.report();
        }, NOTE_REPORT_DEBOUNCE_MS);
    }

    report() {
        const note = describeActiveNote();
        if (!note) {
            return;
        }
        const key = JSON.stringify(note);
        if (key !== this.lastSent) {
            this.lastSent = key;
            this.send(note);
        }
    }
}

export function describeActiveNote(): TfNoteParams | null {
    const context = appContext.tabManager?.getActiveContext();
    const note = context?.note;
    if (!context || !note) {
        return null;
    }

    const path = (context.notePath ?? note.noteId)
        .split("/")
        .filter((noteId) => noteId && noteId !== "root")
        .map((noteId) => froca.notes[noteId]?.title ?? noteId);

    const result: TfNoteParams = { noteId: note.noteId, title: note.title, type: note.type, path };
    const blockId = context.viewScope?.block;
    if (blockId) {
        result.blockId = blockId;
    }
    return result;
}

async function gotoNote({ noteId, blockId }: { noteId?: string; blockId?: string }) {
    if (!noteId) {
        throw new Error("noteId is required");
    }
    const context = appContext.tabManager.getActiveContext();
    const viewScope = blockId ? { block: blockId } : {};
    if (context) {
        await context.setNote(noteId, { viewScope });
    } else {
        await appContext.tabManager.openTabWithNoteWithHoisting(noteId, { activate: true, viewScope });
    }
    return {};
}

function focusEditor() {
    window.focus();
    const context = appContext.tabManager.getActiveContext();
    if (context?.ntxId) {
        void appContext.triggerEvent("focusOnDetail", { ntxId: context.ntxId });
    }
    return {};
}

/**
 * A frame without the `fullscreen` permission cannot enter fullscreen itself, so a request that
 * fails is passed to the host, which can give the frame the whole screen instead.
 */
function installFullscreenBridge(notify: (on: boolean) => void) {
    const original = Element.prototype.requestFullscreen;
    if (typeof original === "function") {
        Element.prototype.requestFullscreen = function (this: Element, options?: FullscreenOptions) {
            return original.call(this, options).catch(() => {
                notify(true);
            });
        };
    }

    const originalExit = document.exitFullscreen?.bind(document);
    if (originalExit) {
        document.exitFullscreen = () => originalExit().catch(() => {
            notify(false);
        });
    }

    document.addEventListener("fullscreenchange", () => notify(!!document.fullscreenElement));
}
