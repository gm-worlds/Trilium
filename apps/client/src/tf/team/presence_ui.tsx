/**
 * Presence in the note's title row (the other people on this note) and the turn bar under it, which
 * says who is typing while the editor waits, with a "Take over" button.
 */
import { createPortal } from "preact";
import { useEffect, useLayoutEffect, useState } from "preact/hooks";

import { t } from "../../services/i18n.js";
import Button from "../../widgets/react/Button.js";
import { DropdownPanel } from "../../widgets/react/Dropdown.js";
import { useNoteContext } from "../../widgets/react/hooks.js";
import { lockableKind } from "./editors.js";
import { initialsOf, othersOnNote, type PresencePerson, stackOf } from "./model.js";
import { canWrite, getTurnLock, useTeam } from "./store.js";

/** A person's initials (or picture) in their presence colour. */
export function Avatar({ person, size = "md" }: { person: { name: string; avatar?: string | null; color?: string }; size?: "sm" | "md" | "lg" }) {
    const style = person.color ? { "--tf-person-color": person.color } : undefined;
    return (
        <span className={`tf-team-avatar tf-team-avatar-${size}`} style={style} aria-hidden="true">
            {person.avatar
                ? <img src={person.avatar} alt="" draggable={false} />
                : initialsOf(person.name)}
        </span>
    );
}

/** The title row of a note split: who else is on the note, and the turn bar under the row. */
export function TitleRowTeam() {
    const { note, noteContext } = useNoteContext();
    const team = useTeam();
    const others = othersOnNote(team.presence, note?.noteId, team.self?.id);
    const split = useNoteSplit();

    return (
        <>
            {others.length > 0 && <PresenceStack people={others} />}
            {split && note && <TurnBarHost split={split} noteId={note.noteId} isActive={!!noteContext?.isActive()} others={others} />}
        </>
    );
}

/**
 * The `.note-split` around the title row. The row can mount before its widget joins the
 * document, so the lookup repeats each frame until the split is there (for up to 10 s).
 */
export function useNoteSplit() {
    const { parentComponent } = useNoteContext();
    const [ split, setSplit ] = useState<HTMLElement | null>(null);

    useLayoutEffect(() => {
        let frame = 0;
        let tries = 0;
        const find = () => {
            const element = parentComponent?.$widget?.[0]?.closest<HTMLElement>(".note-split") ?? null;
            if (element || ++tries > 600) {
                setSplit(element);
                return;
            }
            frame = window.requestAnimationFrame(find);
        };
        find();
        return () => window.cancelAnimationFrame(frame);
    }, [ parentComponent ]);

    return split;
}

function PresenceStack({ people }: { people: PresencePerson[] }) {
    const { shown, extra } = stackOf(people);
    const names = people.map((person) => person.editing ? t("tf.team.person_typing", { name: person.name }) : person.name).join(", ");
    const label = t("tf.team.here_on_note", { names });

    return (
        <DropdownPanel
            className="tf-team-presence"
            buttonClassName="tf-team-presence-button"
            hideToggleArrow
            noSelectButtonStyle
            title={label}
            buttonProps={{ "aria-label": label }}
            placement="bottom-end"
            mobileBottomSheet
            text={(
                <span className="tf-team-stack">
                    {shown.map((person) => (
                        <span key={person.id} className={person.editing ? "tf-team-stack-item is-editing" : "tf-team-stack-item"}>
                            <Avatar person={person} size="sm" />
                        </span>
                    ))}
                    {extra > 0 && <span className="tf-team-stack-more">+{extra}</span>}
                </span>
            )}
        >
            <div className="tf-team-presence-list">
                <div className="tf-team-panel-heading">{t("tf.team.on_this_note")}</div>
                {people.map((person) => (
                    <div key={person.id} className="tf-team-person-row">
                        <Avatar person={person} />
                        <span className="tf-team-person-name">{person.name}</span>
                        {person.editing && <span className="tf-team-typing">{t("tf.team.typing")}</span>}
                    </div>
                ))}
            </div>
        </DropdownPanel>
    );
}

/** Places the turn bar between the title row and the note, inside the split. */
function TurnBarHost({ split, noteId, isActive, others }: { split: HTMLElement; noteId: string; isActive: boolean; others: PresencePerson[] }) {
    const [ host, setHost ] = useState<HTMLElement | null>(null);

    useLayoutEffect(() => {
        const element = document.createElement("div");
        element.className = "tf-team-bar-host";
        // Between the title row and the scroller; team.css keeps the spacing the phone theme gives
        // `.title-row + .scrolling-container`.
        const titleRow = split.querySelector(":scope > .title-row");
        if (titleRow) {
            titleRow.after(element);
        } else {
            split.prepend(element);
        }
        setHost(element);
        return () => element.remove();
    }, [ split ]);

    return host ? createPortal(<TurnBar noteId={noteId} isActive={isActive} others={others} />, host) : null;
}

function TurnBar({ noteId, isActive, others }: { noteId: string; isActive: boolean; others: PresencePerson[] }) {
    const { note } = useNoteContext();
    const team = useTeam();
    const [ flash, setFlash ] = useState(false);
    const kind = lockableKind(note);
    const editor = others.find((person) => person.editing);
    const holder = isActive && team.turn.noteId === noteId ? team.turn.holder : null;
    const who = holder ?? editor ?? null;

    useEffect(() => {
        if (!team.blockedAt || Date.now() - team.blockedAt > 500) {
            return;
        }
        setFlash(true);
        const timer = window.setTimeout(() => setFlash(false), 600);
        return () => window.clearTimeout(timer);
    }, [ team.blockedAt ]);

    if (!who || !canWrite()) {
        return null;
    }

    if (!kind) {
        return editor ? (
            <div className="tf-team-bar is-shared" role="status">
                <span className="bx bx-group" aria-hidden="true" />
                <span className="tf-team-bar-text">{t("tf.team.also_editing", { name: editor.name })}</span>
            </div>
        ) : null;
    }

    const message = isActive && team.turn.takeOverRefused
        ? t("tf.team.still_typing", { name: who.name })
        : t("tf.team.is_typing", { name: who.name });

    return (
        <div className={flash ? "tf-team-bar is-flashing" : "tf-team-bar"} role="status" style={{ "--tf-person-color": who.color }}>
            <Avatar person={who} size="sm" />
            <span className="tf-team-bar-text">{message}</span>
            {isActive && holder && (
                <Button
                    className="tf-team-take-over"
                    text={team.turn.takingOver ? t("tf.team.taking_over") : t("tf.team.take_over")}
                    disabled={team.turn.takingOver}
                    onClick={() => getTurnLock()?.takeOver()}
                />
            )}
        </div>
    );
}
