/**
 * Client half of the save guard (`packages/trilium-core/src/tf/save_guard.ts`) and the session
 * handling for engine calls.
 *
 * Every call of `services/server.ts` passes through {@link tfCallInterceptor} while embedded:
 * - `PUT notes/:noteId/data` carries `x-tf-base-blob`, the blob the editor started from, and a 409
 *   opens {@link ConflictDialog} instead of a generic error toast;
 * - a 401 from the gateway renews the session over the bridge and retries once;
 * - a view-role refusal (`403 { tfReadOnly: true }` from the engine, `403 { error: "read_only" }`
 *   from the gateway) shows one plain toast.
 */
import "./save_guard.css";

import { render } from "preact";
import { useState } from "preact/hooks";

import appContext from "../components/app_context.js";
import froca from "../services/froca.js";
import { t } from "../services/i18n.js";
import LoadResults from "../services/load_results.js";
import server from "../services/server.js";
import toast from "../services/toast.js";
import Button from "../widgets/react/Button.js";
import Modal from "../widgets/react/Modal.js";
import { renewSession } from "./gateway.js";
import { getTfBaseBlob, setTfBaseBlob, type TfCallInterceptor, type TfCallOptions, type TfInterceptedOptions } from "./state.js";

export const TF_BASE_BLOB_HEADER = "x-tf-base-blob";

export interface TfConflict {
    conflict: true;
    blobId?: string;
    editedBy: { id: string; name: string } | null;
    editedAt: string | null;
}

export type ConflictChoice = "keepBoth" | "theirs" | "mine";

const SAVE_URL = /^notes\/([^/?#]+)\/data$/;
const pendingConflicts = new Map<string, Promise<ConflictChoice>>();
let lastReadOnlyToastAt = 0;

/** Lets a test or the dialog decide what to do with a conflict. */
export let askConflict: (noteId: string, conflict: TfConflict) => Promise<ConflictChoice> = showConflictDialog;

export function setConflictAsker(asker: typeof askConflict) {
    askConflict = asker;
}

export const tfCallInterceptor: TfCallInterceptor = async (method, url, componentId, options, next) => {
    const saveMatch = method === "PUT" ? SAVE_URL.exec(url) : null;
    const noteId = saveMatch?.[1];

    if (noteId) {
        const pending = pendingConflicts.get(noteId);
        if (pending) {
            const choice = await pending;
            if (choice !== "mine") {
                // The editor is reloading the other version, so this save of the old text is dropped.
                return undefined;
            }
        }
    }

    const run = async (extraHeaders?: Record<string, string>, allowRenew = true): Promise<unknown> => {
        const failure = { status: 0, text: "" };
        const tf: TfCallOptions = {
            headers: extraHeaders,
            silence: (status, text) => {
                failure.status = status;
                failure.text = text;
                return status === 401 || (status === 409 && !!noteId) || isReadOnlyRefusal(status, text);
            }
        };

        try {
            const body = await next(method, url, componentId, { ...options, tf });
            if (noteId) {
                setTfBaseBlob(noteId, (body as { blobId?: string } | undefined)?.blobId);
            }
            return body;
        } catch (e) {
            if (failure.status === 401 && allowRenew) {
                if (await renewSession()) {
                    return run(extraHeaders, false);
                }
                toast.showError(t("tf.session_lost"));
            } else if (failure.status === 409 && noteId) {
                const conflict = parseJson<TfConflict>(failure.text);
                if (conflict?.conflict) {
                    return resolveConflict(noteId, conflict, options, run);
                }
            } else if (isReadOnlyRefusal(failure.status, failure.text)) {
                showReadOnlyToast();
            }
            throw e;
        }
    };

    const base = noteId ? getTfBaseBlob(noteId) : undefined;
    return run(base ? { [TF_BASE_BLOB_HEADER]: base } : undefined);
};

async function resolveConflict(
    noteId: string,
    conflict: TfConflict,
    options: TfInterceptedOptions,
    run: (headers?: Record<string, string>, allowRenew?: boolean) => Promise<unknown>
) {
    let choicePromise = pendingConflicts.get(noteId);
    if (!choicePromise) {
        choicePromise = askConflict(noteId, conflict);
        pendingConflicts.set(noteId, choicePromise);
    }

    try {
        const choice = await choicePromise;
        if (choice === "mine") {
            return await run({ [TF_BASE_BLOB_HEADER]: "*" });
        }

        if (choice === "keepBoth") {
            await saveAsSibling(noteId, options.data as { content?: unknown } | undefined);
        }
        setTfBaseBlob(noteId, conflict.blobId);
        reloadNoteContent(noteId);
        return undefined;
    } finally {
        pendingConflicts.delete(noteId);
    }
}

/** Saves the local text as a new note right after the conflicting one, in the same parent. */
async function saveAsSibling(noteId: string, data: { content?: unknown } | undefined) {
    const note = froca.notes[noteId];
    const branch = note?.getParentBranches()[0];
    if (!note || !branch) {
        return;
    }

    await server.post(`notes/${branch.parentNoteId}/children?target=after&targetBranchId=${branch.branchId}`, {
        title: t("tf.conflict_your_version", { title: note.title }),
        type: note.type,
        mime: note.mime,
        content: typeof data?.content === "string" ? data.content : ""
    });
}

/** Makes the open editors of the note load the saved content again. */
function reloadNoteContent(noteId: string) {
    const loadResults = new LoadResults([]);
    loadResults.addNoteContent(noteId, "tf-save-guard");
    void appContext.triggerEvent("entitiesReloaded", { loadResults });
}

/** The engine's view-role refusal, or the gateway's (`403 { error: "read_only" }`). */
function isReadOnlyRefusal(status: number, text: string) {
    if (status !== 403) {
        return false;
    }
    const body = parseJson<{ tfReadOnly?: boolean; error?: string }>(text);
    return body?.tfReadOnly === true || body?.error === "read_only";
}

function showReadOnlyToast() {
    const now = Date.now();
    if (now - lastReadOnlyToastAt > 10_000) {
        lastReadOnlyToastAt = now;
        toast.showError(t("tf.read_only"));
    }
}

function parseJson<T>(text: string): T | null {
    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
}

function showConflictDialog(_noteId: string, conflict: TfConflict): Promise<ConflictChoice> {
    return new Promise((resolve) => {
        const container = document.createElement("div");
        document.body.append(container);
        const finish = (choice: ConflictChoice) => {
            resolve(choice);
            // The modal animates out before it unmounts.
            setTimeout(() => {
                render(null, container);
                container.remove();
            }, 400);
        };
        render(<ConflictDialog conflict={conflict} onChoice={finish} />, container);
    });
}

export function ConflictDialog({ conflict, onChoice }: { conflict: TfConflict; onChoice: (choice: ConflictChoice) => void }) {
    const [ shown, setShown ] = useState(true);
    const [ chosen, setChosen ] = useState<ConflictChoice | null>(null);
    const name = conflict.editedBy?.name;

    function choose(choice: ConflictChoice) {
        setChosen(choice);
        setShown(false);
    }

    return (
        <Modal
            className="tf-conflict-dialog"
            title={t("tf.conflict_title")}
            size="md"
            zIndex={2100}
            show={shown}
            onHidden={() => onChoice(chosen ?? "keepBoth")}
            footer={<>
                <Button text={t("tf.conflict_use_theirs")} title={t("tf.conflict_use_theirs_hint")} onClick={() => choose("theirs")} />
                <Button text={t("tf.conflict_use_mine")} title={t("tf.conflict_use_mine_hint")} onClick={() => choose("mine")} />
                <Button kind="primary" text={t("tf.conflict_keep_both")} title={t("tf.conflict_keep_both_hint")} onClick={() => choose("keepBoth")} />
            </>}
        >
            <p className="tf-conflict-message">
                {name ? t("tf.conflict_message", { name }) : t("tf.conflict_message_unknown")}
            </p>
            <p className="tf-conflict-hint">{t("tf.conflict_hint")}</p>
            <ul className="tf-conflict-options">
                <li><strong>{t("tf.conflict_keep_both")}</strong>: {t("tf.conflict_keep_both_hint")}</li>
                <li><strong>{t("tf.conflict_use_theirs")}</strong>: {t("tf.conflict_use_theirs_hint")}</li>
                <li><strong>{t("tf.conflict_use_mine")}</strong>: {t("tf.conflict_use_mine_hint")}</li>
            </ul>
        </Modal>
    );
}
