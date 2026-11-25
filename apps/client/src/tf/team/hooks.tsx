/**
 * The registry the `// tf:` hooks in upstream files read for the team features (presence, turns,
 * comments, @people, authors, unread). Kept free of heavy imports: layouts, the tree, the text
 * editor config and dialogs import it statically, while the code that fills it in loads only once
 * `startTf()` knows the page is embedded. With nothing registered every hook is a no-op.
 */
import type { ComponentChildren, ComponentType, VNode } from "preact";
import { useSyncExternalStore } from "preact/compat";
import { useEffect } from "preact/hooks";

export interface TfTeamHooks {
    /** Decorates one row of the note tree after `enhanceTitle()` rendered it. */
    treeRow(span: HTMLElement, noteId: string): void;
    /** CKEditor plugins (constructors or plugin functions) added to every text editor. */
    editorPlugins(): Promise<unknown[]>;
    /** Component names appended to the phone toolbar's insert tiles. */
    mobileInsertItems(): string[];
    /** Rows for the text editor's right-click menu at `element`. */
    textMenuItems(element: Element | null | undefined): Promise<TfMenuItem[]>;
    /** Rows for the block handle menu of `blocks` in `editor`. */
    blockMenuItems(editor: unknown, blocks: readonly unknown[]): TfMenuItem[];
    /** Suggestions put ahead of the notes in the `@` list of a text note. */
    mentionSuggestions(term: string): Promise<TfMentionSuggestion[]>;
    /** A heading drawn before row `index` of the `@` list ("People", then "Notes"). */
    mentionRowPrefix(items: readonly { action?: string }[], index: number): VNode | null;
    /** Called after a note's content was saved with `data` (`PUT notes/:noteId/data`). */
    noteSaved(noteId: string, data: unknown): void;
    /** Revisions shown in the revisions dialog, after the "By" filter. */
    filterRevisions<T extends { revisionId?: string }>(noteId: string | undefined, revisions: T[]): T[];
    /** Extra widgets of the right pane (desktop) and the phone note panel. */
    rightPaneWidgets(noteId: string | undefined): TfRightPaneWidget[];
    /** The badge of a right pane tab for the note `noteId`. */
    rightPaneTabBadge(tabId: string, noteId: string | undefined): string | null;
}

/** A row of a context menu, the shape `menus/context_menu.ts` takes. */
export interface TfMenuItem {
    title: string;
    uiIcon: string;
    handler: () => void;
}

/** A person row of the `@` list; `notePath` is what the list commits (`tf-person:<id>`). */
export interface TfMentionSuggestion {
    notePath: string;
    noteTitle: string;
    highlightedNotePathTitle: string;
    icon: string;
    action: "tf-person";
}

export interface TfRightPaneWidget {
    el: VNode;
    tab: "tf-comments";
}

export const TF_PERSON_PATH_PREFIX = "tf-person:";

const hooks: Partial<TfTeamHooks> = {};
const slots = new Map<string, ComponentType<any>[]>();
const listeners = new Set<() => void>();
let version = 0;

export function setTfTeamHook<K extends keyof TfTeamHooks>(name: K, hook: TfTeamHooks[K]) {
    hooks[name] = hook;
    if (name === "editorPlugins") {
        releaseTfTeamEditors();
    }
    bumpTfTeam();
}

export function getTfTeamHook<K extends keyof TfTeamHooks>(name: K): TfTeamHooks[K] | undefined {
    return hooks[name];
}

/** `source` with the people of the `mentionSuggestions` hook ahead of its own rows. */
export function withTfMentionPeople<T>(source: (term: string) => Promise<T[]> | T[]): (term: string) => Promise<T[]> {
    return async (term) => {
        const people = hooks.mentionSuggestions;
        const [ found, rest ] = await Promise.all([
            people ? people(term).catch(() => []) : Promise.resolve([]),
            source(term)
        ]);
        return [ ...found as T[], ...rest ];
    };
}

const EDITOR_PLUGINS_WAIT_MS = 2500;
let editorPluginsWaiters: (() => void)[] = [];

/**
 * The extra CKEditor plugins. Inside a frame the first editor can be built before the embedding has
 * started, so this waits for the `editorPlugins` hook (at most 2.5 s); outside a frame it answers at once.
 */
export async function tfTeamEditorPlugins(): Promise<unknown[]> {
    if (!hooks.editorPlugins && typeof window !== "undefined" && window.parent !== window) {
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, EDITOR_PLUGINS_WAIT_MS);
            editorPluginsWaiters.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    return hooks.editorPlugins ? hooks.editorPlugins() : [];
}

/** Lets editors stop waiting for the plugins: the embedding started, or it is not embedded. */
export function releaseTfTeamEditors() {
    const waiters = editorPluginsWaiters;
    editorPluginsWaiters = [];
    for (const waiter of waiters) {
        waiter();
    }
}

/** Adds `component` to the slot `name`; every `<TfTeamSlot name>` renders it with its props. */
export function registerTfTeamSlot(name: string, component: ComponentType<any>) {
    slots.set(name, [ ...(slots.get(name) ?? []), component ]);
    bumpTfTeam();
}

/** Makes every subscriber of {@link useTfTeamVersion} render again. */
export function bumpTfTeam() {
    version++;
    for (const listener of listeners) {
        listener();
    }
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** A number that changes whenever a hook or a slot is registered, or a filter changes. */
export function useTfTeamVersion() {
    return useSyncExternalStore(subscribe, () => version);
}

const badgeListeners = new Set<() => void>();
let badgeVersion = 0;

/** Makes the right pane read its tab badges again. */
export function bumpTfTeamBadges() {
    badgeVersion++;
    for (const listener of badgeListeners) {
        listener();
    }
}

/** A number that changes whenever a badge of a right pane tab can have changed. */
export function useTfTeamBadges() {
    return useSyncExternalStore((listener) => {
        badgeListeners.add(listener);
        return () => {
            badgeListeners.delete(listener);
        };
    }, () => badgeVersion);
}

/**
 * The components registered for `name`. Always renders its wrapper (`display: contents`), since the
 * layouts place only what a widget's first render produced, and the registrations arrive later.
 */
export function TfTeamSlot({ name, inline, ...props }: { name: string; inline?: boolean; [prop: string]: unknown }) {
    useTfTeamVersion();
    const components = slots.get(name) ?? [];
    const children: ComponentChildren = components.map((Component, index) => <Component key={index} {...props} />);
    return inline
        ? <span className="tf-slot" data-tf-slot={name}>{children}</span>
        : <div className="tf-slot" data-tf-slot={name}>{children}</div>;
}

/** Calls `open(tabId)` when the team code asks the phone note panel to open on a tab. */
export function useTfOpenNotePanel(isTarget: (ntxId: string | null | undefined) => boolean, open: (tabId: "tf-comments") => void) {
    useEffect(() => {
        const listener = (event: Event) => {
            const detail = (event as CustomEvent<{ ntxId?: string | null; tabId: "tf-comments" }>).detail;
            if (detail && isTarget(detail.ntxId)) {
                open(detail.tabId);
            }
        };
        window.addEventListener(TF_OPEN_NOTE_PANEL_EVENT, listener);
        return () => window.removeEventListener(TF_OPEN_NOTE_PANEL_EVENT, listener);
    }, [ isTarget, open ]);
}

export const TF_OPEN_NOTE_PANEL_EVENT = "tf-team:open-note-panel";
