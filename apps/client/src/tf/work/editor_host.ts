/**
 * What the upstream editor code asks the work features for. Kept free of heavy imports: the text
 * editor, its toolbar and the export dialog import this module statically, and the rest of
 * `tf/work` loads only once `startTf()` knows the page is embedded.
 */
import type { TfWorkHost } from "@triliumnext/ckeditor5";

import type { MenuItem } from "../../menus/context_menu.js";

import { isTfEmbedCandidate, isTfEmbedded } from "../state.js";

/** Longest wait for `startTf()` to learn whether the page is embedded before an editor is built. */
const DECISION_TIMEOUT_MS = 4000;

let decided = !isTfEmbedCandidate();
let waiters: (() => void)[] = [];
let hostFactory: (() => TfWorkHost) | null = null;
let workFlags: TfWorkFlags = { tasks: false };

export interface TfWorkFlags {
    /** "Make task" is offered: `init.canCreateTasks` and the `edit` role. */
    tasks: boolean;
}

/** Called by `startTf()` once it knows whether the engine runs embedded, with the editor host when it does. */
export function settleTfWork(factory: (() => TfWorkHost) | null) {
    hostFactory = factory;
    decided = true;
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
        waiter();
    }
}

export function setTfWorkFlags(flags: TfWorkFlags) {
    workFlags = flags;
}

export function getTfWorkFlags() {
    return workFlags;
}

/**
 * Resolves once the editor can be configured: at once unless the page is an embed candidate
 * (`isTfEmbedCandidate()`), else when `startTf()` has settled, or after a few seconds at the latest.
 */
export function whenTfEditorReady(): Promise<void> {
    if (decided) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, DECISION_TIMEOUT_MS);
        waiters.push(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

/** Gives a text editor's config the `tfWork` host while embedded; leaves it untouched otherwise. */
export function applyTfEditorConfig(config: object) {
    if (isTfEmbedded() && hostFactory) {
        (config as { tfWork?: TfWorkHost }).tfWork = hostFactory();
    }
}

/** The phone toolbar's work tiles ("Make task", "Remind me"), only while embedded. */
export function getTfWorkToolbarItems(): string[] {
    if (!isTfEmbedded() || !hostFactory) {
        return [];
    }
    return [ "|", ...(workFlags.tasks ? [ "tfMakeTask" ] : []), "tfRemindMe" ];
}

type ContextMenuBuilder = (element: Element | null | undefined) => Promise<MenuItem<string>[]>;
let contextMenuBuilder: ContextMenuBuilder | null = null;

export function setTfWorkContextMenuBuilder(builder: ContextMenuBuilder | null) {
    contextMenuBuilder = builder;
}

/**
 * The rows the text editor's context menu gets while embedded ("Remind me", "Make task"), after a
 * separator; none outside an editable or outside Taskforce.
 */
export async function getTfWorkContextMenuItems<T>(target: { isEditable: boolean; element?: Element | null }): Promise<MenuItem<T>[]> {
    if (!contextMenuBuilder || !target.isEditable) {
        return [];
    }
    const items = await contextMenuBuilder(target.element).catch(() => []);
    return items.length ? [ { kind: "separator" }, ...items ] as MenuItem<T>[] : [];
}
