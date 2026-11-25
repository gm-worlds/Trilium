/**
 * The pieces of the work features that upstream layouts and menus mount: the launch bar buttons
 * (To-dos, Reminders), the bell in a note's title row, and the note menu rows. Each renders nothing
 * unless the notebook runs embedded.
 */
import "./work_components.css";

import { useEffect } from "preact/hooks";

import type FNote from "../../entities/fnote.js";
import { t } from "../../services/i18n.js";
import Button from "../../widgets/react/Button.js";
import Dropdown from "../../widgets/react/Dropdown.js";
import { FormListItem } from "../../widgets/react/FormList.js";
import { useNoteContext } from "../../widgets/react/hooks.js";
import { LaunchBarActionButton, LaunchBarContext } from "../../widgets/launch_bar/launch_bar_widgets.js";
import { useTfBootstrap } from "../components.js";
import { openTfWorkDialog } from "./dialog_bus.js";
import { downloadWord } from "./export_word.js";
import { ReminderRows } from "./RemindersView.js";
import { loadNoteReminders, useTfWork } from "./store.js";

/** "To-dos" and "Reminders" in the desktop launch bar. */
export function TfWorkLaunchButtons({ isHorizontalLayout }: { isHorizontalLayout: boolean }) {
    const bootstrap = useTfBootstrap();
    return (
        <div className="tf-slot tf-work-launch-slot">
            {bootstrap && (
                <LaunchBarContext.Provider value={{ isHorizontalLayout }}>
                    <LaunchBarActionButton
                        className="tf-work-launch tf-work-launch--todos"
                        data-tf-work="todos"
                        icon="bx bx-check-square"
                        text={t("tf.work.todos")}
                        onClick={() => openTfWorkDialog({ kind: "todos" })}
                    />
                    <LaunchBarActionButton
                        className="tf-work-launch tf-work-launch--reminders"
                        data-tf-work="reminders"
                        icon="bx bx-bell"
                        text={t("tf.work.reminders")}
                        onClick={() => openTfWorkDialog({ kind: "reminders" })}
                    />
                </LaunchBarContext.Provider>
            )}
        </div>
    );
}

/** "To-dos" and "Reminders" atop the phone's note navigator, where the bottom bar has no room left. */
export function TfWorkNavigatorRow() {
    const bootstrap = useTfBootstrap();
    if (!bootstrap) {
        return null;
    }
    return (
        <div className="tf-work-navigator-row">
            <Button
                className="tf-work-navigator-button" kind="secondary" icon="bx bx-check-square"
                text={t("tf.work.todos")} data-tf-work="todos"
                onClick={() => openTfWorkDialog({ kind: "todos" })}
            />
            <Button
                className="tf-work-navigator-button" kind="secondary" icon="bx bx-bell"
                text={t("tf.work.reminders")} data-tf-work="reminders"
                onClick={() => openTfWorkDialog({ kind: "reminders" })}
            />
        </div>
    );
}

/** A bell with the number of open reminders on the note; pressing it lists them. */
export function TfNoteWorkBadges() {
    const bootstrap = useTfBootstrap();
    const { note } = useNoteContext();
    const work = useTfWork();
    const noteId = note?.noteId;

    useEffect(() => {
        if (bootstrap && noteId && !noteId.startsWith("_")) {
            loadNoteReminders(noteId).catch(() => {});
        }
    }, [ bootstrap, noteId ]);

    const list = noteId ? work.byNote.get(noteId) ?? [] : [];
    return (
        <div className="tf-slot tf-work-badge-slot">
            {bootstrap && list.length > 0 && (
                <Dropdown
                    className="tf-note-bell"
                    buttonClassName="tf-note-bell-button"
                    buttonProps={{ "aria-label": t("tf.work.reminders_open", { count: list.length }), "data-tf-work": "bell" } as never}
                    title={t("tf.work.reminders_open", { count: list.length })}
                    text={<><span className="bx bx-bell" aria-hidden="true" /><span className="tf-note-bell-count">{list.length}</span></>}
                    hideToggleArrow
                    noSelectButtonStyle
                    mobileBottomSheet
                    dropdownContainerClassName="tf-note-bell-menu"
                >
                    <ReminderRows reminders={list} />
                </Dropdown>
            )}
        </div>
    );
}

/** "Remind me..." and "Download as Word" in the note menu. */
export function TfWorkNoteMenuItems({ note }: { note: FNote }) {
    const bootstrap = useTfBootstrap();
    if (!bootstrap || note.noteId.startsWith("_")) {
        return null;
    }
    return (
        <>
            <FormListItem
                icon="bx bx-bell"
                onClick={() => openTfWorkDialog({ kind: "remind", noteId: note.noteId, text: note.title })}
            >{t("tf.work.remind_me_menu")}</FormListItem>
            {(note.type === "text" || note.type === "code") && (
                <FormListItem icon="bx bxs-file-doc" onClick={() => void downloadWord(note.noteId, false)}>
                    {t("tf.work.export_word")}
                </FormListItem>
            )}
        </>
    );
}
