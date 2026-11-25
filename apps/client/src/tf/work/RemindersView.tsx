import i18next from "i18next";
import { useEffect, useState } from "preact/hooks";

import froca from "../../services/froca.js";
import { t } from "../../services/i18n.js";
import toast from "../../services/toast.js";
import ActionButton from "../../widgets/react/ActionButton.js";
import Modal from "../../widgets/react/Modal.js";
import NoItems from "../../widgets/react/NoItems.js";
import { getTfBootstrap } from "../state.js";
import { reminders as remindersApi, type TfReminder } from "./api.js";
import { openNoteAt } from "./navigation.js";
import { formatWhen, inOneHour, type ReminderGroup, reminderGroup, tomorrowMorning } from "./reminder_time.js";
import { dropReminder, loadMyReminders, reminderTime, upsertReminder, useTfWork } from "./store.js";

const GROUPS: ReminderGroup[] = [ "overdue", "today", "later" ];

/** The person's own open reminders in this notebook, grouped Overdue / Today / Later. */
export function RemindersDialog({ onClose }: { onClose(): void }) {
    const [ shown, setShown ] = useState(true);
    const [ failed, setFailed ] = useState(false);
    const work = useTfWork();

    useEffect(() => {
        loadMyReminders().catch(() => setFailed(true));
    }, []);

    const now = new Date();
    const list = work.mine ?? [];
    return (
        <Modal className="tf-work-dialog tf-reminders-dialog" title={t("tf.work.reminders_notebook")} size="md" show={shown} onHidden={onClose} scrollable>
            {work.mine === null && !failed && <div className="tf-work-loading" aria-busy="true" />}
            {failed && <p className="tf-work-error" role="alert">{t("tf.work.reminder_failed")}</p>}
            {work.mine !== null && list.length === 0 && <NoItems icon="bx bx-bell" text={t("tf.work.reminders_none")} />}
            {GROUPS.map((group) => {
                const rows = list.filter((reminder) => reminderGroup(reminderTime(reminder), now) === group);
                if (!rows.length) {
                    return null;
                }
                return (
                    <section className={`tf-reminder-group tf-reminder-group--${group}`} key={group}>
                        <h3 className="tf-work-heading">{t(`tf.work.group_${group}`)}</h3>
                        <ReminderRows reminders={rows} showNote onOpen={() => setShown(false)} />
                    </section>
                );
            })}
        </Modal>
    );
}

/** One row per reminder: time, text, person, and Done / Snooze / Delete. */
export function ReminderRows({ reminders, showNote, onOpen }: { reminders: TfReminder[]; showNote?: boolean; onOpen?(): void }) {
    const me = getTfBootstrap()?.user?.id;
    return (
        <ul className="tf-reminder-rows">
            {reminders.map((reminder) => {
                const when = reminderTime(reminder);
                const overdue = when.getTime() <= Date.now();
                const forSomeoneElse = reminder.user && reminder.user.id !== me;
                return (
                    <li className={`tf-reminder-row${overdue ? " tf-reminder-row--overdue" : ""}`} key={reminder.id}>
                        <button
                            type="button"
                            className="tf-reminder-main"
                            onClick={() => {
                                onOpen?.();
                                void openNoteAt(reminder.noteId, reminder.blockId);
                            }}
                        >
                            <span className="tf-reminder-when">{formatWhen(when, i18next.language)}</span>
                            <span className="tf-reminder-text">{reminder.text}</span>
                            <span className="tf-reminder-meta">
                                {forSomeoneElse ? reminder.user?.name : null}
                                {reminder.createdBy && reminder.createdBy.id !== me ? t("tf.work.reminder_set_by", { name: reminder.createdBy.name }) : null}
                                {showNote && froca.notes[reminder.noteId] ? (
                                    <span className="tf-reminder-note">
                                        {reminder.blockId && <span className="bx bx-time-five" role="img" aria-label={t("tf.work.reminder_on_item")} />}
                                        {froca.notes[reminder.noteId]?.title}
                                    </span>
                                ) : null}
                            </span>
                        </button>
                        <span className="tf-reminder-actions">
                            <ActionButton icon="bx bx-check" text={t("tf.work.reminder_done")} onClick={() => void act(reminder, "done")} />
                            <ActionButton icon="bx bx-alarm-snooze" text={t("tf.work.snooze_hour")} onClick={() => void act(reminder, "hour")} />
                            <ActionButton icon="bx bx-sun" text={t("tf.work.snooze_tomorrow")} onClick={() => void act(reminder, "tomorrow")} />
                            <ActionButton icon="bx bx-trash" text={t("tf.work.reminder_delete")} onClick={() => void act(reminder, "delete")} />
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

/** Done, snooze an hour or until tomorrow morning, or delete; the lists follow at once. */
export async function act(reminder: TfReminder, action: "done" | "hour" | "tomorrow" | "delete") {
    try {
        if (action === "delete") {
            await remindersApi.remove(reminder.id);
            dropReminder(reminder);
            return;
        }
        const now = new Date();
        if (action === "done") {
            upsertReminder(await remindersApi.update(reminder.id, { doneAt: now.toISOString() }));
            return;
        }
        const until = action === "hour" ? inOneHour(now) : tomorrowMorning(now);
        upsertReminder(await remindersApi.update(reminder.id, { snoozedUntil: until.toISOString() }));
        toast.showMessage(t("tf.work.reminder_snoozed", { when: formatWhen(until, i18next.language) }));
    } catch {
        toast.showError(t("tf.work.reminder_failed"));
    }
}
