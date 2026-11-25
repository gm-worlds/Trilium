/**
 * Per-person options for an embedded notebook.
 *
 * Everyone in a Taskforce notebook shares one Trilium document, so options that describe how one
 * person looks at it (open tabs, theme, pane sizes, language) are stored per person, as options
 * named `tfu.<userId>.<name>`. Reads fall back to the shared value until the person writes their
 * own. The shared value stays as it is, which keeps the document usable outside Taskforce.
 */
import type { EntityChange } from "@triliumnext/commons";

import becca from "../becca/becca.js";
import { getTfUserId, isTfEmbedded } from "./identity.js";

/**
 * | Option | Why it is per person |
 * |---|---|
 * | `openNoteContexts` | the open tabs and splits; one person's tabs must never replace another's |
 * | `hoistedNoteId` | the workspace someone has entered is their navigation state |
 * | `theme` | driven by the Taskforce host's light or dark mode for each person |
 * | `locale`, `formattingLocale` | display and date language of the person |
 * | `firstDayOfWeek`, `firstWeekOfYear`, `minDaysInFirstWeek` | calendar layout that goes with the formatting locale |
 * | `zoomFactor` | reading comfort |
 * | `leftPaneWidth`, `leftPaneVisible` | tree pane size and visibility |
 * | `rightPaneWidth`, `rightPaneVisible`, `rightPaneCollapsedItems`, `rightPaneSelectedTab`, `rightPaneNoteMapType` | right pane state |
 * | `presentationSidebarVisible` | pane visibility |
 * | `layoutOrientation`, `splitEditorOrientation` | screen layout |
 * | `mainFontSize`, `treeFontSize`, `detailFontSize`, `monospaceFontSize` | reading comfort |
 * | `mainFontFamily`, `treeFontFamily`, `detailFontFamily`, `monospaceFontFamily`, `overrideThemeFonts` | reading comfort |
 * | `motionEnabled`, `shadowsEnabled`, `backdropEffectsEnabled`, `smoothScrollEnabled` | visual effects, can matter for accessibility |
 * | `maxContentWidth`, `centerContent` | reading width |
 * | `treeDensity`, `autoCollapseNoteTree`, `treeScrollFollowNavigation` | tree behaviour while browsing |
 * | `headingStyle` | how headings are drawn, not what is stored |
 * | `codeBlockTheme`, `codeBlockThemeMatchesApp`, `codeBlockThemeLight`, `codeBlockThemeDark` | syntax colours follow the person's theme |
 * | `codeNoteTheme`, `codeNoteThemeMatchesApp`, `codeNoteThemeLight`, `codeNoteThemeDark` | same, for code notes |
 * | `contentManagerViewMode`, `contentManagerSortOrder` | how a list is shown |
 * | `editedNotesOpenInRibbon` | ribbon state |
 * | `vimKeymapEnabled`, `codeLineWrapEnabled`, `codeLineNumbersEnabled` | editor display and key handling |
 * | `spellCheckEnabled`, `spellCheckLanguageCode` | the person's spelling language |
 * | `textNoteEditorType`, `textNoteEditorMultilineToolbar` | toolbar style |
 * | `seenCallToActions` | which hints a person has already dismissed |
 * | any name ending in `Collapsed` | collapsed sections of the UI |
 *
 * Shared on purpose: anything that changes stored content or document behaviour (revision and
 * erase intervals, protected session timeout, typing replacements, date/time insert format,
 * content languages, allowed HTML, image handling, AI, OCR, sync, backup, password, MFA) and
 * keyboard shortcuts, which the host overrides through `init.shortcuts` anyway.
 */
export const TF_PER_USER_OPTIONS: ReadonlySet<string> = new Set([
    "openNoteContexts",
    "hoistedNoteId",
    "theme",
    "locale",
    "formattingLocale",
    "firstDayOfWeek",
    "firstWeekOfYear",
    "minDaysInFirstWeek",
    "zoomFactor",
    "leftPaneWidth",
    "leftPaneVisible",
    "rightPaneWidth",
    "rightPaneVisible",
    "rightPaneCollapsedItems",
    "rightPaneSelectedTab",
    "rightPaneNoteMapType",
    "presentationSidebarVisible",
    "layoutOrientation",
    "splitEditorOrientation",
    "mainFontSize",
    "treeFontSize",
    "detailFontSize",
    "monospaceFontSize",
    "mainFontFamily",
    "treeFontFamily",
    "detailFontFamily",
    "monospaceFontFamily",
    "overrideThemeFonts",
    "motionEnabled",
    "shadowsEnabled",
    "backdropEffectsEnabled",
    "smoothScrollEnabled",
    "maxContentWidth",
    "centerContent",
    "treeDensity",
    "autoCollapseNoteTree",
    "treeScrollFollowNavigation",
    "headingStyle",
    "codeBlockTheme",
    "codeBlockThemeMatchesApp",
    "codeBlockThemeLight",
    "codeBlockThemeDark",
    "codeNoteTheme",
    "codeNoteThemeMatchesApp",
    "codeNoteThemeLight",
    "codeNoteThemeDark",
    "contentManagerViewMode",
    "contentManagerSortOrder",
    "editedNotesOpenInRibbon",
    "vimKeymapEnabled",
    "codeLineWrapEnabled",
    "codeLineNumbersEnabled",
    "spellCheckEnabled",
    "spellCheckLanguageCode",
    "textNoteEditorType",
    "textNoteEditorMultilineToolbar",
    "seenCallToActions"
]);

export const TF_USER_OPTION_PREFIX = "tfu.";

/**
 * Options only the embedding has, all per person. Upstream's `ALLOWED_OPTIONS` does not list them;
 * `isReadable()` in `routes/api/options.ts` asks {@link isTfOwnOption} instead.
 *
 * | Option | Meaning |
 * |---|---|
 * | `tfTextScale` | reading size of note content, 0.8 to 2.2 (`tf/mobile/text_size.ts` in the client) |
 */
export const TF_OWN_OPTIONS: ReadonlySet<string> = new Set([ "tfTextScale" ]);

/** Whether `name` is one of {@link TF_OWN_OPTIONS}; always `false` outside embed mode. */
export function isTfOwnOption(name: string) {
    return isTfEmbedded() && TF_OWN_OPTIONS.has(name);
}

export function isTfPerUserOption(name: string) {
    return TF_PER_USER_OPTIONS.has(name) || TF_OWN_OPTIONS.has(name) || name.endsWith("Collapsed");
}

export function tfUserOptionName(userId: string, name: string) {
    return `${TF_USER_OPTION_PREFIX}${userId}.${name}`;
}

/** The option name a read of `name` resolves to for the person in context. */
export function resolveTfOptionRead<T extends string>(name: T): T {
    const userName = currentUserOptionName(name);
    if (userName && becca.getOption(userName)) {
        return userName as T;
    }
    return name;
}

/** The option name a write of `name` goes to for the person in context. */
export function resolveTfOptionWrite<T extends string>(name: T): T {
    return (currentUserOptionName(name) ?? name) as T;
}

/**
 * Applies the current person's values over the shared ones and removes every `tfu.*` entry, so a
 * person never receives another person's tabs. Outside embed mode the map is returned unchanged.
 */
export function applyTfOptionOverlay<M extends Record<string, string>>(map: M): M {
    if (!isTfEmbedded()) {
        return map;
    }

    const userId = getTfUserId();
    const ownPrefix = userId ? tfUserOptionName(userId, "") : null;
    const result: Record<string, string> = {};
    const own: Record<string, string> = {};

    for (const [name, value] of Object.entries(map)) {
        if (!name.startsWith(TF_USER_OPTION_PREFIX)) {
            result[name] = value;
        } else if (ownPrefix && name.startsWith(ownPrefix)) {
            own[name.substring(ownPrefix.length)] = value;
        }
    }

    for (const [name, value] of Object.entries(own)) {
        if (isTfPerUserOption(name)) {
            result[name] = value;
        }
    }

    return result as M;
}

/**
 * Rewrites the entity changes of a `frontend-update` message for one connected person: their own
 * `tfu.<id>.<name>` options arrive under the plain name, other people's are dropped, and a shared
 * change to an option the person has overridden is dropped too.
 */
export function filterTfEntityChangesForUser(entityChanges: EntityChange[], userId: string | null): EntityChange[] {
    const ownPrefix = userId ? tfUserOptionName(userId, "") : null;
    const result: EntityChange[] = [];

    for (const change of entityChanges) {
        if (change.entityName !== "options") {
            result.push(change);
            continue;
        }

        const name = change.entityId;
        if (name.startsWith(TF_USER_OPTION_PREFIX)) {
            if (!ownPrefix || !name.startsWith(ownPrefix)) {
                continue;
            }
            const plainName = name.substring(ownPrefix.length);
            const entity = change.entity ? { ...change.entity, name: plainName } : change.entity;
            result.push({ ...change, entityId: plainName, entity });
            continue;
        }

        if (ownPrefix && isTfPerUserOption(name) && becca.getOption(ownPrefix + name)) {
            continue;
        }
        result.push(change);
    }

    return result;
}

/** Whether the option `name` belongs to the person with `userId`. */
export function isOwnTfUserOption(name: string, userId: string) {
    return name.startsWith(tfUserOptionName(userId, ""));
}

function currentUserOptionName(name: string): string | null {
    if (!isTfPerUserOption(name)) {
        return null;
    }
    const userId = getTfUserId();
    return userId ? tfUserOptionName(userId, name) : null;
}
