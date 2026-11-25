/**
 * To-do checkboxes of an included note on touch. Trilium shows an included note read-only, so its
 * checkboxes are disabled and a tap on one only focuses the editor around it, which opens the
 * keyboard. Here a tap within `TODO_TAP_PAD_PX` of such a checkbox ticks it in the included note
 * through `POST /api/tf/todos/toggle` (the save guard's path, from the blob the tap saw); the box
 * shows the new state at once and goes back when the engine refuses. While someone else has the
 * turn on that note nothing is sent.
 */
import froca from "../../services/froca.js";
import { t } from "../../services/i18n.js";
import toast from "../../services/toast.js";
import { todoItemAt } from "../work/editor_logic.js";
import { distance, distanceToBox, type Point } from "./gestures.js";

/** The same margin `setupTodoCheckboxTaps()` gives the checkboxes of the edited note. */
export const TODO_TAP_PAD_PX = 14;
const TAP_SLOP_PX = 10;
const CHECKBOXES = ".todo-list input[type=checkbox]";

export function installIncludedTodos(isTouch: () => boolean) {
    let pending: { include: HTMLElement; noteId: string; index: number; at: Point } | null = null;

    document.addEventListener("touchstart", (e) => {
        pending = null;
        if (!isTouch() || e.touches.length !== 1 || !(e.target instanceof Element)) {
            return;
        }
        const include = e.target.closest<HTMLElement>(".include-note[data-note-id]");
        const noteId = include?.dataset.noteId;
        if (!include || !noteId) {
            return;
        }
        const at = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        const index = checkboxIndexAt(include, at);
        if (index < 0) {
            return;
        }
        // Keeps the editor around the include from taking focus and opening the keyboard.
        e.preventDefault();
        pending = { include, noteId, index, at };
    }, { capture: true, passive: false });

    document.addEventListener("touchend", (e) => {
        const tap = pending;
        pending = null;
        const touch = e.changedTouches[0];
        if (!tap || !touch || distance(tap.at, { x: touch.clientX, y: touch.clientY }) > TAP_SLOP_PX) {
            return;
        }
        e.preventDefault();
        void toggleIncludedTodo(tap.include, tap.noteId, tap.index);
    }, { capture: true, passive: false });
}

/** Index, among the include's own checkboxes, of the one within reach of `at`, or -1. */
function checkboxIndexAt(include: HTMLElement, at: Point) {
    const own = ownCheckboxes(include);
    let best = -1;
    let bestDistance = TODO_TAP_PAD_PX;
    for (const [ index, box ] of own.entries()) {
        const d = distanceToBox(at, box.getBoundingClientRect());
        if (d <= bestDistance) {
            best = index;
            bestDistance = d;
        }
    }
    return best;
}

async function toggleIncludedTodo(include: HTMLElement, noteId: string, index: number) {
    // Loaded here, so this module stays light for what imports it early.
    const [ { isNoteTaken, turnHolderName }, { TfEngineError, todos } ] = await Promise.all([
        import("../team/tracker.js"),
        import("../work/api.js")
    ]);
    if (isNoteTaken(noteId)) {
        const name = turnHolderName(noteId);
        toast.showMessage(name ? t("tf.team.todo_busy", { name }) : t("tf.team.todo_busy_someone"), 3000);
        return;
    }
    const note = await froca.getNote(noteId);
    const blob = note ? await note.getBlob() : null;
    if (!note || !blob?.blobId || note.type !== "text" || !note.isContentAvailable()) {
        return;
    }
    const target = todoItemAt(blob.content, index);
    const box = ownCheckboxes(include)[index];
    if (!target) {
        return;
    }
    const checked = !target.checked;
    if (box) {
        box.checked = checked;
    }
    try {
        await todos.toggle({ noteId, blockId: target.blockId, index: target.index, checked, baseBlobId: blob.blobId });
    } catch (e) {
        if (box) {
            box.checked = !checked;
        }
        toast.showMessage(t(e instanceof TfEngineError && e.status === 409 ? "tf.team.todo_changed" : "tf.team.failed"), 3000);
    }
}

function ownCheckboxes(include: HTMLElement) {
    return [ ...include.querySelectorAll<HTMLInputElement>(CHECKBOXES) ]
        .filter((box) => box.closest(".include-note[data-note-id]") === include);
}

/**
 * Ticks or unticks the `index`-th to-do checkbox of a text note's HTML, not counting checkboxes
 * of notes it includes in turn. `null` when there is no such checkbox.
 */
export function toggleTodoInHtml(html: string, index: number) {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const box = [ ...doc.body.querySelectorAll(CHECKBOXES) ][index];
    if (!box) {
        return null;
    }
    if (box.hasAttribute("checked")) {
        box.removeAttribute("checked");
    } else {
        box.setAttribute("checked", "checked");
    }
    return doc.body.innerHTML;
}
