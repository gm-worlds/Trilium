/**
 * Tells the to-do list when notes changed, from Trilium's own entity-change events (no polling):
 * the content of a text note, a note created, moved, deleted or archived.
 */
import appContext from "../../components/app_context.js";
import Component from "../../components/component.js";
import froca from "../../services/froca.js";
import type LoadResults from "../../services/load_results.js";

type Listener = () => void;

const listeners = new Set<Listener>();
let watcher: TodoChangeWatcher | null = null;

export function subscribeTodoChanges(listener: Listener) {
    if (!watcher) {
        watcher = new TodoChangeWatcher();
        appContext.child(watcher);
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

class TodoChangeWatcher extends Component {
    entitiesReloadedEvent({ loadResults }: { loadResults: LoadResults }) {
        if (!listeners.size || !touchesTodos(loadResults)) {
            return;
        }
        for (const listener of listeners) {
            listener();
        }
    }
}

export function touchesTodos(loadResults: LoadResults) {
    for (const noteId of loadResults.getNoteIds()) {
        const note = froca.notes[noteId];
        if (!note || note.type === "text") {
            return true;
        }
    }
    if (loadResults.getBranchRows().length) {
        return true;
    }
    return loadResults.getAttributeRows().some((row) => row.name === "archived");
}
