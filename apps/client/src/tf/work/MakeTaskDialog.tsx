import { useEffect, useRef, useState } from "preact/hooks";

import { t } from "../../services/i18n.js";
import toast from "../../services/toast.js";
import Button from "../../widgets/react/Button.js";
import FormGroup from "../../widgets/react/FormGroup.js";
import FormSelect from "../../widgets/react/FormSelect.js";
import FormTextBox from "../../widgets/react/FormTextBox.js";
import Modal from "../../widgets/react/Modal.js";
import { TfGatewayError } from "../gateway.js";
import { isTfTouch } from "../state.js";
import { getPeople, tasks, type TfPerson, type TfTaskChip } from "./api.js";
import { newRequestId } from "./editor_logic.js";

const NOBODY = "";

/** "Make task": a title (from the line), an assignee and an optional due date. */
export default function MakeTaskDialog({ noteId, blockId, text, noteTitle, onCreated, onClose }: {
    noteId: string;
    blockId: string;
    text: string;
    noteTitle: string;
    onCreated(chip: TfTaskChip): void;
    onClose(): void;
}) {
    const [ shown, setShown ] = useState(true);
    const [ title, setTitle ] = useState(text.slice(0, 500));
    const [ assignee, setAssignee ] = useState(NOBODY);
    const [ due, setDue ] = useState("");
    const [ people, setPeople ] = useState<TfPerson[]>([]);
    const [ saving, setSaving ] = useState(false);
    const [ error, setError ] = useState<string | null>(null);
    // One id for everything this dialog sends: Taskforce answers a repeat with the first task.
    const [ requestId ] = useState(() => newRequestId());
    const busy = useRef(false);

    useEffect(() => {
        getPeople().then(setPeople).catch(() => setPeople([]));
    }, []);

    const options = [ { id: NOBODY, name: t("tf.work.task_nobody") }, ...people.map((p) => ({ id: p.id, name: p.name })) ];

    async function submit() {
        const name = title.trim();
        // A ref, since a second press can come before the disabled button is drawn.
        if (!name || busy.current) {
            return;
        }
        busy.current = true;
        setSaving(true);
        setError(null);
        try {
            const { chip } = await tasks.create({
                requestId,
                noteId,
                blockId,
                title: name,
                excerpt: text.slice(0, 1000),
                noteTitle,
                ...(assignee ? { assigneeId: assignee } : {}),
                ...(due ? { dueAt: new Date(`${due}T12:00:00`).toISOString() } : {})
            });
            onCreated(chip);
            toast.showMessage(t("tf.work.task_created"));
            setShown(false);
        } catch (e) {
            // Only a failure frees the button; after a success the dialog is closing.
            busy.current = false;
            setSaving(false);
            setError(taskError(e));
        }
    }

    return (
        <Modal
            className="tf-work-dialog tf-make-task-dialog"
            title={t("tf.work.make_task_title")}
            size="md"
            show={shown}
            onHidden={onClose}
            onSubmit={() => void submit()}
            footer={<Button kind="primary" text={t("tf.work.task_create")} disabled={saving || !title.trim()} />}
        >
            <FormGroup name="tf-task-title" label={t("tf.work.task_title")}>
                <FormTextBox name="tf-task-title" currentValue={title} onChange={setTitle} maxLength={500} required autoFocus={!isTfTouch()} />
            </FormGroup>
            <div className="tf-make-task-row">
                <FormGroup name="tf-task-assignee" label={t("tf.work.task_assignee")}>
                    <FormSelect name="tf-task-assignee" values={options} keyProperty="id" titleProperty="name" currentValue={assignee} onChange={setAssignee} />
                </FormGroup>
                <FormGroup name="tf-task-due" label={t("tf.work.task_due")}>
                    <FormTextBox name="tf-task-due" type="date" currentValue={due} onChange={setDue} />
                </FormGroup>
            </div>
            {error && <p className="tf-work-error" role="alert">{error}</p>}
        </Modal>
    );
}

function taskError(e: unknown) {
    if (e instanceof TfGatewayError) {
        const code = (e.body as { error?: string } | null)?.error;
        if (code === "no_tasks_tab") {
            return t("tf.work.task_no_tab");
        }
        if (code === "not_a_member") {
            return t("tf.work.task_not_member");
        }
        if (code === "read_only") {
            return t("tf.work.task_not_allowed");
        }
    }
    return t("tf.work.task_failed");
}
