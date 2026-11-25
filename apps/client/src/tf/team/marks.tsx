/**
 * Marks on the rows of the note tree and the phone navigator: a dot in each person's colour where
 * someone else is (their names in the row's accessible name), a bold title and an accent dot on
 * unread notes, and a hollow dot on the ancestors of unread notes while their branch is folded.
 */
import { t } from "../../services/i18n.js";
import { presenceByNote, type PresencePerson, type UnreadMark } from "./model.js";
import { getTeam, subscribeTeam, useTeam } from "./store.js";

const ROW_SELECTOR = "span.fancytree-node[data-tf-note-id]";

/** The `treeRow` hook: called by `enhanceTitle()` for every row the tree renders. */
export function decorateTreeRow(span: HTMLElement, noteId: string) {
    span.dataset.tfNoteId = noteId;
    const team = getTeam();
    applyTreeMarks(span, presenceByNote(team.presence, team.self?.id).get(noteId) ?? [], team.unreadMarks.get(noteId));
}

/** Decorates the rows already on screen again whenever presence or the unread marks change. */
export function installTreeRefresh() {
    let lastKey = "";
    subscribeTeam(() => {
        const team = getTeam();
        const byNote = presenceByNote(team.presence, team.self?.id);
        const key = JSON.stringify([ [ ...byNote ].map(([ id, people ]) => [ id, people.map((p) => p.id) ]), [ ...team.unreadMarks ] ]);
        if (key === lastKey) {
            return;
        }
        lastKey = key;
        for (const span of document.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
            const noteId = span.dataset.tfNoteId as string;
            applyTreeMarks(span, byNote.get(noteId) ?? [], team.unreadMarks.get(noteId));
        }
    });
}

function applyTreeMarks(span: HTMLElement, people: PresencePerson[], mark: UnreadMark | undefined) {
    for (const old of span.querySelectorAll(".tf-team-tree-mark, .tf-team-sr")) {
        old.remove();
    }
    span.classList.toggle("tf-team-unread", mark === "unread");
    span.classList.toggle("tf-team-unread-ancestor", mark === "ancestor");
    if (!people.length && !mark) {
        return;
    }

    const holder = document.createElement("span");
    holder.className = "tf-team-tree-mark";
    holder.setAttribute("aria-hidden", "true");
    for (const person of people.slice(0, 3)) {
        const dot = document.createElement("span");
        dot.className = person.editing ? "tf-team-dot is-person is-editing" : "tf-team-dot is-person";
        dot.style.setProperty("--tf-person-color", person.color);
        holder.append(dot);
    }
    if (mark) {
        const dot = document.createElement("span");
        dot.className = mark === "unread" ? "tf-team-dot is-unread" : "tf-team-dot is-ancestor";
        holder.append(dot);
    }

    const title = span.querySelector(".fancytree-title");
    const label = rowLabel(people, mark);
    if (title && label) {
        const sr = document.createElement("span");
        sr.className = "tf-team-sr";
        sr.textContent = `, ${label}`;
        title.append(sr);
    }
    (title ?? span).after(holder);
}

/** What a row's marks say to assistive technology. */
export function rowLabel(people: PresencePerson[], mark: UnreadMark | undefined) {
    const parts: string[] = [];
    if (people.length) {
        parts.push(t("tf.team.row_people", { names: people.map((person) => person.name).join(", ") }));
    }
    if (mark === "unread") {
        parts.push(t("tf.team.row_unread"));
    } else if (mark === "ancestor") {
        parts.push(t("tf.team.row_unread_inside"));
    }
    return parts.join(", ");
}

/** The marks of one phone navigator row, mounted by the `navigator-row` slot. */
export function NavigatorRowTeam({ noteId }: { noteId: string }) {
    const team = useTeam();
    const people = presenceByNote(team.presence, team.self?.id).get(noteId) ?? [];
    const mark = team.unreadMarks.get(noteId);
    if (!people.length && !mark) {
        return null;
    }
    return (
        <span className={mark === "unread" ? "tf-team-nav-mark has-unread" : "tf-team-nav-mark"}>
            <span className="tf-team-sr">{rowLabel(people, mark)}</span>
            {people.slice(0, 3).map((person) => (
                <span
                    key={person.id}
                    aria-hidden="true"
                    className={person.editing ? "tf-team-dot is-person is-editing" : "tf-team-dot is-person"}
                    style={{ "--tf-person-color": person.color }}
                />
            ))}
            {mark && <span aria-hidden="true" className={mark === "unread" ? "tf-team-dot is-unread" : "tf-team-dot is-ancestor"} />}
        </span>
    );
}
