import i18next from "i18next";
import { useEffect, useMemo, useState } from "preact/hooks";

import { t } from "../../services/i18n.js";
import toast from "../../services/toast.js";
import Button from "../../widgets/react/Button.js";
import DatePicker from "../../widgets/react/DatePicker.js";
import FormGroup from "../../widgets/react/FormGroup.js";
import FormSelect from "../../widgets/react/FormSelect.js";
import FormTextBox from "../../widgets/react/FormTextBox.js";
import Modal from "../../widgets/react/Modal.js";
import { TfGatewayError } from "../gateway.js";
import { getTfBootstrap, isTfTouch } from "../state.js";
import { getPeople, reminders, type TfPerson } from "./api.js";
import { formatClock, formatWhen, fromLocalParts, quickChoices, toLocalParts, tomorrowMorning } from "./reminder_time.js";
import { upsertReminder } from "./store.js";

const ME = "";

/** "Remind me": quick times, a date and time, the text, and who it is for. */
export default function ReminderDialog({ noteId, blockId, text: initialText, onClose }: {
    noteId: string;
    blockId?: string;
    text: string;
    onClose(): void;
}) {
    const [ shown, setShown ] = useState(true);
    const [ text, setText ] = useState(initialText.slice(0, 500));
    const initial = useMemo(() => toLocalParts(tomorrowMorning(new Date())), []);
    const [ date, setDate ] = useState(initial.date);
    const [ time, setTime ] = useState(initial.time);
    const [ forUser, setForUser ] = useState(ME);
    const [ people, setPeople ] = useState<TfPerson[]>([]);
    const [ saving, setSaving ] = useState(false);
    const [ error, setError ] = useState<string | null>(null);
    const choices = useMemo(() => quickChoices(new Date()), []);
    const touch = isTfTouch();
    const me = getTfBootstrap()?.user;
    const canSetForOthers = me?.role === "edit";

    useEffect(() => {
        if (!canSetForOthers) {
            return;
        }
        getPeople().then(setPeople).catch(() => setPeople([]));
    }, [ canSetForOthers ]);

    const options = [
        { id: ME, name: t("tf.work.reminder_for_me") },
        ...people.filter((person) => person.id !== me?.id).map((person) => ({ id: person.id, name: person.name }))
    ];

    async function save(at: Date | null) {
        if (!at) {
            return;
        }
        if (at.getTime() <= Date.now()) {
            setError(t("tf.work.reminder_in_past"));
            return;
        }
        const body = text.trim();
        if (!body) {
            return;
        }
        setSaving(true);
        setError(null);
        try {
            const reminder = await reminders.create({
                noteId,
                ...(blockId ? { blockId } : {}),
                dueAt: at.toISOString(),
                text: body,
                ...(forUser ? { userId: forUser } : {})
            });
            upsertReminder(reminder);
            toast.showMessage(t("tf.work.reminder_saved", { when: formatWhen(at, i18next.language) }));
            setShown(false);
        } catch (e) {
            setError(reminderError(e));
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal
            className="tf-work-dialog tf-reminder-dialog"
            title={t("tf.work.reminder_title")}
            size="md"
            show={shown}
            onHidden={onClose}
            onSubmit={() => void save(fromLocalParts(date, time))}
            footer={<Button kind="primary" text={t("tf.work.reminder_save")} disabled={saving || !text.trim()} />}
        >
            <FormGroup name="tf-reminder-text" label={t("tf.work.reminder_text")}>
                <FormTextBox name="tf-reminder-text" currentValue={text} onChange={setText} maxLength={500} required autoFocus={!touch} />
            </FormGroup>

            <div className="tf-reminder-quick" role="group" aria-label={t("tf.work.reminder_when")}>
                {choices.map((choice) => (
                    <Button
                        key={choice.key}
                        className="tf-reminder-quick-button"
                        kind="secondary"
                        text={t(`tf.work.quick_${choice.key}`, { time: formatClock(choice.at, i18next.language) })}
                        disabled={saving || !text.trim()}
                        onClick={(e) => {
                            e.preventDefault();
                            void save(choice.at);
                        }}
                    />
                ))}
            </div>

            <div className="tf-reminder-when">
                {touch ? (
                    <FormGroup name="tf-reminder-date" label={t("tf.work.reminder_date")}>
                        <FormTextBox name="tf-reminder-date" type="date" currentValue={date} onChange={setDate} required />
                    </FormGroup>
                ) : (
                    <div className="tf-reminder-calendar">
                        <DatePicker value={date} onChange={setDate} />
                    </div>
                )}
                <FormGroup name="tf-reminder-time" label={t("tf.work.reminder_time")}>
                    <FormTextBox name="tf-reminder-time" type="time" currentValue={time} onChange={setTime} required />
                </FormGroup>
            </div>

            {canSetForOthers && (
                <FormGroup name="tf-reminder-for" label={t("tf.work.reminder_for")}>
                    <FormSelect name="tf-reminder-for" values={options} keyProperty="id" titleProperty="name" currentValue={forUser} onChange={setForUser} />
                </FormGroup>
            )}

            {error && <p className="tf-work-error" role="alert">{error}</p>}
        </Modal>
    );
}

function reminderError(e: unknown) {
    if (e instanceof TfGatewayError) {
        const code = (e.body as { error?: string } | null)?.error;
        if (code === "not_a_member") {
            return t("tf.work.reminder_not_member");
        }
        if (code === "read_only") {
            return t("tf.work.reminder_read_only");
        }
    }
    return t("tf.work.reminder_failed");
}
