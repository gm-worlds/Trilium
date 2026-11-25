/**
 * Start of the work features (reminders, to-do roll-up, tasks from notes, live chips, Word export)
 * inside an embedded notebook. Called by `startTf()`.
 */
import "./work.css";

import { getTextEditorContaining } from "../../menus/text_editor_context_menu.js";
import { t } from "../../services/i18n.js";
import toast from "../../services/toast.js";
import { registerCapability } from "../bridge.js";
import { tfRealtime } from "../gateway.js";
import type { TfBootstrap } from "../state.js";
import type { TfTaskChip } from "./api.js";
import { mountTfWorkDialogs } from "./dialogs.js";
import { setTfWorkContextMenuBuilder, setTfWorkFlags, settleTfWork } from "./editor_host.js";
import { createTfWorkHost, onChipUpdated, pluginOf, refreshOpenEditors, workMenuItems } from "./editor_work.js";
import { openNoteAt } from "./navigation.js";
import { act } from "./RemindersView.js";
import { getTfWorkState, loadMyReminders, loadNoteReminders } from "./store.js";
import { addTfWorkTranslations } from "./translations.js";

export const TF_WORK_CAPABILITIES = [ "tf-reminders-1", "tf-todos-1", "tf-tasks-1", "tf-chips-1", "tf-docx-1" ];

const FOCUS_REFRESH_MS = 1000;

/** Before the bridge says `ready`: the capabilities and the strings. */
export function registerTfWorkCapabilities() {
    addTfWorkTranslations();
    for (const name of TF_WORK_CAPABILITIES) {
        registerCapability(name);
    }
}

/** `init` from the host: tasks only when Taskforce allows them. */
export function setTfWorkInit(params: { canCreateTasks?: boolean }) {
    if (params.canCreateTasks === false) {
        setTfWorkFlags({ tasks: false });
    }
}

/** After the bootstrap: editors get the work host, the dialogs mount, realtime events are heard. */
export function startTfWork(bootstrap: TfBootstrap) {
    setTfWorkFlags({ tasks: bootstrap.user?.role === "edit" });
    settleTfWork(createTfWorkHost);
    mountTfWorkDialogs();

    setTfWorkContextMenuBuilder(async (element) => {
        const editor = element ? await getTextEditorContaining(element) : null;
        if (!editor || !pluginOf(editor)?.host) {
            return [];
        }
        return workMenuItems(editor);
    });

    const realtime = tfRealtime();
    realtime.on("chip.updated", (data: { kind?: string; id?: string; chip?: TfTaskChip | null }) => {
        if (data?.kind === "task" && data.id) {
            onChipUpdated(data.id, data.chip ?? null);
        }
    });
    realtime.on("reminder.due", (data: { id: string; noteId: string; blockId: string | null; text: string; dueAt: string }) => {
        if (!data?.id) {
            return;
        }
        showDueToast(data);
        if (getTfWorkState().mine) {
            loadMyReminders().catch(() => {});
        }
        if (getTfWorkState().byNote.has(data.noteId)) {
            loadNoteReminders(data.noteId).catch(() => {});
        }
    });

    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener("focus", () => {
        if (focusTimer) {
            clearTimeout(focusTimer);
        }
        focusTimer = setTimeout(refreshOpenEditors, FOCUS_REFRESH_MS);
    });
}

function showDueToast(data: { id: string; noteId: string; blockId: string | null; text: string; dueAt: string }) {
    const reminder = getTfWorkState().mine?.find((r) => r.id === data.id)
        ?? [ ...getTfWorkState().byNote.values() ].flat().find((r) => r.id === data.id);
    toast.showPersistent({
        id: `tf-reminder-${data.id}`,
        icon: "bx bx-bell",
        title: t("tf.work.reminder_due_title"),
        message: data.text,
        buttons: [
            {
                text: t("tf.work.reminder_open_note"),
                onClick: ({ dismissToast }) => {
                    dismissToast();
                    void openNoteAt(data.noteId, data.blockId);
                }
            },
            {
                text: t("tf.work.snooze_hour"),
                onClick: ({ dismissToast }) => {
                    dismissToast();
                    void act(reminder ?? {
                        id: data.id, noteId: data.noteId, blockId: data.blockId, text: data.text, dueAt: data.dueAt,
                        snoozedUntil: null, doneAt: null, notifiedAt: null, user: null, createdBy: null, createdAt: data.dueAt
                    }, "hour");
                }
            }
        ]
    });
}
