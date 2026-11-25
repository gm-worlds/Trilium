/**
 * Opens the work dialogs from anywhere (launch bar, note menu, editor) without loading them: the
 * dialog root registers itself here once `startTfWork()` has mounted it.
 */
import type { TfTaskChip } from "./api.js";

export type TfWorkDialogRequest =
    | { kind: "remind"; noteId: string; blockId?: string; text: string }
    | { kind: "makeTask"; noteId: string; blockId: string; text: string; noteTitle: string; onCreated(chip: TfTaskChip): void }
    | { kind: "reminders" }
    | { kind: "todos"; noteId?: string };

type Listener = (request: TfWorkDialogRequest) => void;

let listener: Listener | null = null;
let pending: TfWorkDialogRequest | null = null;

export function openTfWorkDialog(request: TfWorkDialogRequest) {
    if (listener) {
        listener(request);
    } else {
        pending = request;
    }
}

/** Registers the dialog root; a request made before it mounted is handed over at once. */
export function setTfWorkDialogListener(next: Listener | null) {
    listener = next;
    if (next && pending) {
        const request = pending;
        pending = null;
        next(request);
    }
}
