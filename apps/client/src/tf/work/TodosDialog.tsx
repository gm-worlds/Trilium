import type { TaskStateDef } from "@triliumnext/commons";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

import appContext from "../../components/app_context.js";
import contextMenu, { type MenuItem } from "../../menus/context_menu.js";
import { t } from "../../services/i18n.js";
import { getTaskStateDefinitions } from "../../services/task_states.js";
import toast from "../../services/toast.js";
import Modal from "../../widgets/react/Modal.js";
import NoItems from "../../widgets/react/NoItems.js";
import { tfHaptic } from "../bridge.js";
import { TfEngineError, type TfTodoItem, type TfTodoList, todos } from "./api.js";
import { openNoteAt } from "./navigation.js";
import { subscribeTodoChanges } from "./todo_changes.js";

type Scope = "notebook" | "subtree";
const REFRESH_DEBOUNCE_MS = 400;

/** Every open to-do of the notebook (or under the current note), grouped by note. */
export default function TodosDialog({ noteId: initialNoteId, onClose }: { noteId?: string; onClose(): void }) {
    const [ shown, setShown ] = useState(true);
    const [ scope, setScope ] = useState<Scope>("notebook");
    const [ list, setList ] = useState<TfTodoList | null>(null);
    const [ failed, setFailed ] = useState(false);
    const [ states, setStates ] = useState<TaskStateDef[]>([]);
    const [ busy, setBusy ] = useState<Set<string>>(new Set());
    const subtreeNoteId = useRef(initialNoteId ?? appContext.tabManager.getActiveContext()?.note?.noteId);
    const request = useRef(0);

    const load = useCallback(async (cursor?: string) => {
        const id = ++request.current;
        try {
            const next = await todos.list({ scope, noteId: scope === "subtree" ? subtreeNoteId.current : undefined, cursor });
            if (id !== request.current) {
                return;
            }
            setFailed(false);
            setList((previous) => cursor && previous ? { ...next, items: [ ...previous.items, ...next.items ], notes: mergeNotes(previous, next) } : next);
        } catch {
            if (id === request.current) {
                setFailed(true);
            }
        }
    }, [ scope ]);

    useEffect(() => {
        setList(null);
        void load();
    }, [ load ]);

    useEffect(() => {
        void getTaskStateDefinitions().then(setStates).catch(() => setStates([]));
    }, []);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const unsubscribe = subscribeTodoChanges(() => {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS);
        });
        return () => {
            unsubscribe();
            if (timer) {
                clearTimeout(timer);
            }
        };
    }, [ load ]);

    const keyOf = (item: TfTodoItem) => `${item.noteId}:${item.blockId ?? item.index}`;

    async function toggle(item: TfTodoItem, change: { checked: boolean } | { state: string }) {
        const note = list?.notes.find((n) => n.noteId === item.noteId);
        if (!list || !note) {
            return;
        }
        const key = keyOf(item);
        const before = list;
        const checked = "checked" in change ? change.checked : !!states.find((s) => s.name === change.state)?.isCompleted;
        setList({ ...list, items: list.items.map((i) => keyOf(i) === key ? { ...i, checked, completed: checked, ...("state" in change ? { state: change.state } : {}) } : i) });
        setBusy((set) => new Set(set).add(key));
        tfHaptic("light");
        try {
            const answer = await todos.toggle({ noteId: item.noteId, blockId: item.blockId, index: item.index, baseBlobId: note.blobId, ...change });
            setList((current) => current && {
                ...current,
                notes: current.notes.map((n) => n.noteId === item.noteId ? { ...n, blobId: answer.blobId } : n),
                items: current.items.map((i) => keyOf(i) === key ? answer.item : i)
            });
        } catch (e) {
            setList(before);
            if (e instanceof TfEngineError && e.status === 409) {
                toast.showMessage(t("tf.work.todos_stale"));
            } else {
                toast.showError(t("tf.work.todos_toggle_failed"));
            }
            void load();
        } finally {
            setBusy((set) => {
                const next = new Set(set);
                next.delete(key);
                return next;
            });
        }
    }

    function showStates(item: TfTodoItem, x: number, y: number) {
        const active = states.filter((s) => !s.isHidden);
        if (!active.length) {
            return;
        }
        const items: MenuItem<string>[] = active.map((s) => ({
            title: s.title,
            uiIcon: s.icon,
            checked: s.name === item.state,
            handler: () => void toggle(item, { state: s.name })
        }));
        void contextMenu.show({ x, y, items, selectMenuItemHandler: () => {}, forcePositionOnMobile: true });
    }

    const groups = groupByNote(list?.items ?? []);
    const openCount = list ? list.total - list.items.filter((i) => i.completed).length : 0;

    return (
        <Modal
            className="tf-work-dialog tf-todos-dialog"
            title={<h5 className="modal-title tf-todos-title">{t("tf.work.todos_title")}{list && <span className="tf-work-count">{t("tf.work.todos_count", { count: openCount })}</span>}</h5>}
            size="lg"
            show={shown}
            onHidden={onClose}
            scrollable
        >
            <div className="tf-todos-scope" role="radiogroup" aria-label={t("tf.work.todos")}>
                {([ "notebook", "subtree" ] as Scope[]).map((value) => (
                    <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={scope === value}
                        className={`tf-segment${scope === value ? " tf-segment--on" : ""}`}
                        disabled={value === "subtree" && !subtreeNoteId.current}
                        onClick={() => setScope(value)}
                    >{t(`tf.work.todos_scope_${value}`)}</button>
                ))}
            </div>
            {!list && !failed && <div className="tf-work-loading" aria-busy="true" />}
            {failed && <p className="tf-work-error" role="alert">{t("tf.work.todos_load_failed")}</p>}
            {list && !list.items.length && <NoItems icon="bx bx-check-square" text={t("tf.work.todos_empty")}><p className="tf-work-hint">{t("tf.work.todos_empty_hint")}</p></NoItems>}
            {groups.map(({ noteId, items }) => {
                const first = items[0];
                return (
                    <section className="tf-todo-group" key={noteId}>
                        <button
                            type="button"
                            className="tf-todo-note"
                            onClick={() => {
                                setShown(false);
                                void openNoteAt(noteId);
                            }}
                        >
                            <span className="tf-todo-note-title">{first.noteTitle}</span>
                            {first.notePath.length > 0 && <span className="tf-todo-note-path">{first.notePath.join(" / ")}</span>}
                        </button>
                        <ul className="tf-todo-rows">
                            {items.map((item) => {
                                const key = keyOf(item);
                                return (
                                    <li className={`tf-todo-row${item.completed ? " tf-todo-row--done" : ""}`} key={key} data-tf-todo={key}>
                                        <label className="tf-todo-check" onContextMenu={(e) => {
                                            e.preventDefault();
                                            showStates(item, e.pageX, e.pageY);
                                        }}>
                                            <input
                                                type="checkbox"
                                                checked={item.checked}
                                                disabled={busy.has(key)}
                                                aria-label={t(item.checked ? "tf.work.todos_mark_open" : "tf.work.todos_mark_done", { text: item.text })}
                                                onChange={(e) => void toggle(item, { checked: (e.currentTarget as HTMLInputElement).checked })}
                                            />
                                        </label>
                                        <button
                                            type="button"
                                            className="tf-todo-text"
                                            onClick={() => {
                                                setShown(false);
                                                void openNoteAt(item.noteId, item.blockId, item.index);
                                            }}
                                        >
                                            {item.text || " "}
                                        </button>
                                        {item.stateTitle && (
                                            <button type="button" className="tf-todo-state" title={t("tf.work.todos_state")} onClick={(e) => {
                                                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                                                showStates(item, rect.left + window.scrollX, rect.bottom + window.scrollY);
                                            }}>{item.stateTitle}</button>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                );
            })}
            {list?.next && (
                <button type="button" className="tf-todo-more btn btn-secondary" onClick={() => void load(list.next ?? undefined)}>{t("tf.work.todos_more")}</button>
            )}
        </Modal>
    );
}

function groupByNote(items: TfTodoItem[]) {
    const groups: { noteId: string; items: TfTodoItem[] }[] = [];
    for (const item of items) {
        const last = groups[groups.length - 1];
        if (last && last.noteId === item.noteId) {
            last.items.push(item);
        } else {
            groups.push({ noteId: item.noteId, items: [ item ] });
        }
    }
    return groups;
}

function mergeNotes(previous: TfTodoList, next: TfTodoList) {
    const seen = new Set(previous.notes.map((n) => n.noteId));
    return [ ...previous.notes, ...next.notes.filter((n) => !seen.has(n.noteId)) ];
}
