/**
 * Whether the notebook runs embedded in Taskforce, and the little the upstream hooks need to know
 * about it. Kept free of heavy imports: layouts, menus and dialogs import it statically, and the
 * rest of `tf/` loads only once `startTf()` knows the page is embedded.
 */
import { installTfHistory } from "./history.js";

export interface TfBootstrap {
    embed: true;
    notebookId: string;
    user: { id: string; name: string; role: "edit" | "view" } | null;
    parentOrigins: string[];
    engineVersion: string;
    upstreamVersion: string;
    sourceUrl: string;
}

type Listener = () => void;

let bootstrap: TfBootstrap | null = null;
const listeners = new Set<Listener>();

export function getTfBootstrap() {
    return bootstrap;
}

export function isTfEmbedded() {
    return bootstrap !== null;
}

/** Whether the embedded notebook is used with a finger (`tf/mobile`, class `tf-touch`). */
export function isTfTouch() {
    return bootstrap !== null && document.documentElement.classList.contains("tf-touch");
}

export function setTfBootstrap(value: TfBootstrap | null) {
    bootstrap = value;
    document.documentElement.classList.toggle("tf-embedded", !!value);
    notifyTf();
}

/** Calls `listener` whenever the embedded state changes. Returns the unsubscribe function. */
export function subscribeTf(listener: Listener) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function notifyTf() {
    for (const listener of listeners) {
        listener();
    }
}

/**
 * Option pages that have no meaning inside Taskforce: the gateway handles sign-in, sync, backups,
 * API access and scripting, so their settings would only fail or mislead.
 */
const HIDDEN_OPTION_PAGES = new Set([
    "_optionsSync",
    "_optionsPassword",
    "_optionsEtapi",
    "_optionsBackup",
    "_optionsDatabase",
    "_optionsSecurity",
    "_optionsResources"
]);

/** Global menu commands hidden inside Taskforce for the same reasons. */
const HIDDEN_COMMANDS = new Set<string>([
    "logout",
    "openNewWindow",
    "showSQLConsole",
    "showSQLConsoleHistory",
    "showBackendLog"
]);

export function isTfHiddenOptionPage(noteId: string) {
    return isTfEmbedded() && HIDDEN_OPTION_PAGES.has(noteId);
}

export function isTfHiddenCommand(command: unknown) {
    return isTfEmbedded() && typeof command === "string" && HIDDEN_COMMANDS.has(command);
}

const baseBlobs = new Map<string, string>();

/**
 * The blob a note's editor started from, sent as `tf-base-blob` with its next save. Set when an
 * editor loads content (`useEditorSpacedUpdate()`) and after each own save.
 */
export function setTfBaseBlob(noteId: string, blobId: string | undefined | null) {
    if (blobId) {
        baseBlobs.set(noteId, blobId);
    }
}

export function getTfBaseBlob(noteId: string) {
    return baseBlobs.get(noteId);
}

/**
 * Starts the embedding when the page runs in a frame. Outside a frame nothing is loaded, so a plain
 * Trilium start-up makes no extra request.
 */
export function maybeStartTf() {
    if (window.parent === window) {
        return;
    }
    void import("./index.js").then((tf) => tf.startTf());
}

// Before `appContext.start()` restores the tabs, so the first navigations add no host history either.
if (typeof window !== "undefined" && window.parent !== window) {
    installTfHistory();
}

/** What the embedding adds to one call of `services/server.ts`. */
export interface TfCallOptions {
    headers?: Record<string, string>;
    /** Returns `true` for an error the embedding reports itself, which skips the generic toast. */
    silence?: (status: number, responseText: string) => boolean;
}

export interface TfInterceptedOptions {
    data?: unknown;
    tf?: TfCallOptions;
}

export type TfCallNext = (method: string, url: string, componentId: string | undefined, options: TfInterceptedOptions) => Promise<unknown>;

/** Wraps every call of `services/server.ts` while embedded; `next` performs the call. */
export type TfCallInterceptor = (
    method: string, url: string, componentId: string | undefined, options: TfInterceptedOptions, next: TfCallNext
) => Promise<unknown>;

const mindMaps = new WeakMap<Element, unknown>();

/** Records the Mind Elixir instance drawn in `container`, for the touch gestures of `tf/mobile`. */
export function registerTfMindMap(container: Element | null, instance: unknown) {
    if (container && isTfEmbedded()) {
        mindMaps.set(container, instance);
    }
}

export function getTfMindMap(container: Element) {
    return mindMaps.get(container) ?? null;
}

/**
 * Whether the engine runs with notebook scripts off (`TF_SCRIPTS=off`), read from the page
 * bootstrap so the client asks for no startup scripts, widgets or render-note scripts at all.
 */
export function isTfScriptsOff() {
    return !!(window.glob as { tfScriptsOff?: boolean } | undefined)?.tfScriptsOff;
}
