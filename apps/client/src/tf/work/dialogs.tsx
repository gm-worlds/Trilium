/**
 * The dialogs of the work features, mounted once in their own root by {@link mountTfWorkDialogs}
 * and opened through `openTfWorkDialog()` of `dialog_bus.ts`.
 */
import "./work.css";

import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

import { setTfWorkDialogListener, type TfWorkDialogRequest } from "./dialog_bus.js";
import MakeTaskDialog from "./MakeTaskDialog.js";
import ReminderDialog from "./ReminderDialog.js";
import { RemindersDialog } from "./RemindersView.js";
import TodosDialog from "./TodosDialog.js";

let mounted = false;

export function mountTfWorkDialogs() {
    if (mounted) {
        return;
    }
    mounted = true;
    const container = document.createElement("div");
    container.className = "tf-work-dialogs";
    document.body.append(container);
    render(<TfWorkDialogs />, container);
}

function TfWorkDialogs() {
    const [ request, setRequest ] = useState<(TfWorkDialogRequest & { key: number }) | null>(null);

    useEffect(() => {
        let key = 0;
        setTfWorkDialogListener((next) => setRequest({ ...next, key: ++key }));
        return () => setTfWorkDialogListener(null);
    }, []);

    if (!request) {
        return null;
    }
    // A dialog reports "closed" only after its hide animation. By then the person may have opened
    // the next one, so a close only clears the request it belongs to.
    const mine = request.key;
    const close = () => setRequest((current) => (current?.key === mine ? null : current));
    switch (request.kind) {
        case "remind":
            return <ReminderDialog key={request.key} noteId={request.noteId} blockId={request.blockId} text={request.text} onClose={close} />;
        case "makeTask":
            return <MakeTaskDialog {...request} key={request.key} onClose={close} />;
        case "reminders":
            return <RemindersDialog key={request.key} onClose={close} />;
        case "todos":
            return <TodosDialog key={request.key} noteId={request.noteId} onClose={close} />;
    }
}
