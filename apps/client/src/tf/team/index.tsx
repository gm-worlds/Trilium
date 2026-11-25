/**
 * The team features of the embedded notebook: presence, taking turns in one note, comments, @people
 * in note text, authors in history and unread marks. Started by `startTf()` once the page is known
 * to be embedded; registers the capabilities `ready` announces, fills in the hooks the upstream
 * files call (`hooks.tsx`) and starts the team store.
 */
import "./team.css";

import type { CKTextEditor } from "@triliumnext/ckeditor5";

import appContext from "../../components/app_context.js";
import froca from "../../services/froca.js";
import { useNoteContext } from "../../widgets/react/hooks.js";
import { registerCapability, type TfBridge } from "../bridge.js";
import type { TfBootstrap } from "../state.js";
import { blockMenuItems, CommentMarkers, installMentionCards, mentionRowPrefix, mentionSuggestions, onEditorContentLoaded, onNoteSaved, openThread, startComment, textMenuItems } from "./actions.js";
import { filterRevisions, RevisionAuthor, RevisionFilter, TitleDetailsTeam } from "./authors_ui.js";
import { CommentsWidget } from "./comments_ui.js";
import { registerTfTeamSlot, releaseTfTeamEditors, setTfTeamHook } from "./hooks.js";
import { LaunchBarTeam, NavigatorHeaderTeam } from "./lists_ui.js";
import { decorateTreeRow, installTreeRefresh, NavigatorRowTeam } from "./marks.js";
import { TitleRowTeam, useNoteSplit } from "./presence_ui.js";
import { canWrite, getTeam, isMember, loadThreads, personById, setOpenNoteIds, startTeamStore, subscribePeople } from "./store.js";
import { installTracker, onTextEditorChange, setTurnBypass } from "./tracker.js";
import { addTeamTranslations } from "./translations.js";

export const TF_TEAM_CAPABILITIES = [ "tf-presence-1", "tf-turns-1", "tf-comments-1", "tf-people-1", "tf-authors-1", "tf-unread-1" ];

let installed = false;

/** Call before the bridge announces `ready`, so the capabilities are in it. */
export function installTfTeam(bootstrap: TfBootstrap) {
    if (installed || !bootstrap.user) {
        releaseTfTeamEditors();
        return;
    }
    installed = true;
    for (const capability of TF_TEAM_CAPABILITIES) {
        registerCapability(capability);
    }
    addTeamTranslations();

    setOpenNoteIds(() => appContext.tabManager?.getNoteContexts().map((context) => context.note?.noteId).filter((id): id is string => !!id) ?? []);
    startTeamStore({
        self: { id: bootstrap.user.id, name: bootstrap.user.name, role: bootstrap.user.role === "edit" ? "edit" : "view" },
        parentsOf: async (noteIds) => {
            await loadAncestors(noteIds);
            return (noteId) => froca.getNoteFromCache(noteId)?.getParentNoteIds() ?? [];
        }
    });

    registerTfTeamSlot("title-row", TitleRowSlot);
    registerTfTeamSlot("launch-bar", LaunchBarTeam);
    registerTfTeamSlot("navigator-header", NavigatorHeaderTeam);
    registerTfTeamSlot("navigator-row", NavigatorRowTeam);
    registerTfTeamSlot("title-details", TitleDetailsTeam);
    registerTfTeamSlot("revision-author", RevisionAuthor);
    registerTfTeamSlot("revision-filter", RevisionFilter);

    setTfTeamHook("treeRow", decorateTreeRow);
    setTfTeamHook("textMenuItems", textMenuItems);
    setTfTeamHook("blockMenuItems", blockMenuItems);
    setTfTeamHook("mentionSuggestions", mentionSuggestions);
    setTfTeamHook("mentionRowPrefix", mentionRowPrefix);
    setTfTeamHook("noteSaved", onNoteSaved);
    setTfTeamHook("filterRevisions", filterRevisions);
    setTfTeamHook("mobileInsertItems", () => canWrite() ? [ "|", "tfComment" ] : []);
    setTfTeamHook("rightPaneWidgets", (noteId) => noteId ? [ { el: <CommentsWidget />, tab: "tf-comments" } ] : []);
    setTfTeamHook("rightPaneTabBadge", (tabId, noteId) => {
        const count = tabId === "tf-comments" && noteId ? getTeam().commentCounts[noteId] ?? 0 : 0;
        return count > 0 ? String(count) : null;
    });
    let plugin: Promise<unknown> | null = null;
    setTfTeamHook("editorPlugins", async () => {
        plugin ??= import("./editor_plugin.js").then(({ createTeamEditorPlugin }) => createTeamEditorPlugin({
            person: (id) => personById(id),
            isMember,
            subscribePeople,
            contentLoaded: (editor) => onEditorContentLoaded(editor),
            modelChanged: (editor, batch) => onTextEditorChange(editor as CKTextEditor, batch),
            startComment: (editor) => startComment(editor),
            canComment: () => canWrite()
        }));
        return [ await plugin ];
    });

    installTracker();
    installTreeRefresh();
    installMentionCards();
    // Read-only state for debugging and the team check. The turn bypass exists only for the
    // check (it proves the save guard holds without locks) and needs the check's own flag.
    (window as unknown as { __tfTeam?: unknown }).__tfTeam = {
        getTeam,
        setTurnBypass(on: boolean) {
            if (window.localStorage.getItem("tfCheck") !== "1") throw new Error("turn bypass is for the team check only");
            setTurnBypass(on);
        }
    };
}

/** Wraps the bridge's `goto` so a `commentId` also opens the comments panel on that thread. */
export function installTfTeamGoto(bridge: TfBridge, goto: (params: { noteId?: string; blockId?: string }) => Promise<unknown>) {
    bridge.on("goto", async (params: { noteId?: string; blockId?: string; commentId?: string }) => {
        const result = await goto(params);
        if (params.commentId && params.noteId) {
            const noteId = params.noteId;
            const commentId = params.commentId;
            await loadThreads(noteId, true);
            const threads = getTeam().threads.get(noteId) ?? [];
            const thread = threads.find((entry) => entry.id === commentId || entry.replies.some((reply) => reply.id === commentId));
            openThread(noteId, thread?.id ?? commentId);
        }
        return result;
    });
}

async function loadAncestors(noteIds: string[]) {
    let pending = noteIds;
    for (let depth = 0; depth < 12 && pending.length; depth++) {
        const notes = await froca.getNotes(pending, true);
        const next = new Set<string>();
        for (const note of notes) {
            for (const parentId of note.getParentNoteIds()) {
                if (parentId !== "none" && !froca.getNoteFromCache(parentId)) {
                    next.add(parentId);
                }
            }
        }
        pending = [ ...next ];
    }
}

/** The `title-row` slot: presence and the turn bar, and the comment markers of a text note. */
function TitleRowSlot() {
    const { note, noteContext } = useNoteContext();
    const split = useNoteSplit();

    return (
        <>
            <TitleRowTeam />
            {split && note?.type === "text" && <CommentMarkers split={split} noteId={note.noteId} ntxId={noteContext?.ntxId} />}
        </>
    );
}
