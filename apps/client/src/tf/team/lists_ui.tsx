/**
 * "People here" (everyone else in the notebook and the note each is on) and "What changed" (the
 * notes others changed since this person last saw them), in the desktop launch bar and in the
 * header of the phone navigator.
 */
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";

import appContext from "../../components/app_context.js";
import froca from "../../services/froca.js";
import { t } from "../../services/i18n.js";
import { isMobile } from "../../services/utils.js";
import { LaunchBarContext } from "../../widgets/launch_bar/launch_bar_widgets.js";
import Button from "../../widgets/react/Button.js";
import { DropdownPanel } from "../../widgets/react/Dropdown.js";
import Icon from "../../widgets/react/Icon.js";
import NoItems from "../../widgets/react/NoItems.js";
import { formatAgo, othersOf, type PresencePerson, type UnreadNote } from "./model.js";
import { Avatar } from "./presence_ui.js";
import { markAllSeen, useTeam } from "./store.js";

export async function openNoteFromTeam(noteId: string) {
    const context = appContext.tabManager.getActiveContext();
    if (context) {
        await context.setNote(noteId);
    } else {
        await appContext.tabManager.openTabWithNoteWithHoisting(noteId, { activate: true });
    }
    if (isMobile()) {
        void appContext.triggerCommand("setActiveScreen", { screen: "detail" });
    }
}

/** The two buttons at the top of the vertical launch bar (or after the Taskforce button). */
export function LaunchBarTeam({ isHorizontalLayout }: { isHorizontalLayout?: boolean }) {
    if (isMobile()) {
        return null;
    }
    const placement = isHorizontalLayout ? "bottom-start" : "right-start";
    return (
        <LaunchBarContext.Provider value={{ isHorizontalLayout: !!isHorizontalLayout }}>
            <PeopleHereButton variant="launcher" placement={placement} />
            <WhatChangedButton variant="launcher" placement={placement} />
        </LaunchBarContext.Provider>
    );
}

/** The same two controls as a row in the phone navigator's header. */
export function NavigatorHeaderTeam() {
    if (!isMobile()) {
        return null;
    }
    return (
        <div className="tf-team-navigator-header">
            <PeopleHereButton variant="row" placement="bottom-start" />
            <WhatChangedButton variant="row" placement="bottom-end" />
        </div>
    );
}

type Variant = "launcher" | "row";
type Placement = "bottom-start" | "bottom-end" | "right-start";

function useTitles(noteIds: string[]) {
    const key = noteIds.join(",");
    const [ titles, setTitles ] = useState<Record<string, string>>({});
    useEffect(() => {
        let cancelled = false;
        void froca.getNotes(noteIds, true).then((notes) => {
            if (!cancelled) {
                setTitles(Object.fromEntries(notes.map((note) => [ note.noteId, note.title ])));
            }
        }).catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [ key ]);
    return titles;
}

function PanelButton({ variant, placement, icon, label, count, className, children }: {
    variant: Variant;
    placement: Placement;
    icon: string;
    label: string;
    count: number;
    className: string;
    children: ComponentChildren;
}) {
    const badge = count > 0 && <span className="tf-team-count" aria-hidden="true">{count > 99 ? "99+" : count}</span>;
    const fullLabel = count > 0 ? `${label} (${count})` : label;

    return (
        <DropdownPanel
            className={variant === "launcher" ? `right-dropdown-widget ${className}` : `tf-team-row-control ${className}`}
            buttonClassName={variant === "launcher" ? "right-dropdown-button launcher-button tf-team-launcher" : "tf-team-row-button"}
            hideToggleArrow
            noSelectButtonStyle={variant === "row"}
            title={fullLabel}
            titlePosition={variant === "launcher" ? (placement === "right-start" ? "right" : "bottom") : undefined}
            buttonProps={{ "aria-label": fullLabel }}
            placement={placement}
            mobileBottomSheet
            scrollable
            text={variant === "launcher"
                ? <span className="tf-team-launcher-face"><Icon icon={icon} />{badge}</span>
                : <span className="tf-team-row-face"><Icon icon={icon} /><span className="tf-team-row-label">{label}</span>{badge}</span>}
        >
            <div className="tf-team-list-panel">{children}</div>
        </DropdownPanel>
    );
}

export function PeopleHereButton({ variant, placement }: { variant: Variant; placement: Placement }) {
    const team = useTeam();
    const others = othersOf(team.presence, team.self?.id).toSorted((a, b) => a.name.localeCompare(b.name));
    const titles = useTitles(others.map((person) => person.noteId).filter((id): id is string => !!id));

    return (
        <PanelButton
            variant={variant} placement={placement} className="tf-team-people-here"
            icon="bx bx-group" label={t("tf.team.people_here")} count={others.length}
        >
            <div className="tf-team-panel-heading">{t("tf.team.people_here")}</div>
            {others.length === 0
                ? <NoItems icon="bx bx-user" text={t("tf.team.nobody_here")} />
                : others.map((person) => <PersonRow key={person.id} person={person} title={person.noteId ? titles[person.noteId] : undefined} />)}
        </PanelButton>
    );
}

function PersonRow({ person, title }: { person: PresencePerson; title: string | undefined }) {
    const where = person.noteId
        ? (person.editing ? t("tf.team.typing_in", { title: title ?? "…" }) : t("tf.team.on_note", { title: title ?? "…" }))
        : t("tf.team.no_note_open");
    return (
        <button
            type="button"
            className="dropdown-item tf-team-person-row tf-team-jump"
            disabled={!person.noteId}
            onClick={() => person.noteId && void openNoteFromTeam(person.noteId)}
        >
            <Avatar person={person} />
            <span className="tf-team-row-text">
                <span className="tf-team-person-name">{person.name}</span>
                <span className="tf-team-row-detail">{where}</span>
            </span>
        </button>
    );
}

export function WhatChangedButton({ variant, placement }: { variant: Variant; placement: Placement }) {
    const team = useTeam();
    const notes = team.unread.notes.toSorted((a, b) => b.changedAt.localeCompare(a.changedAt));

    return (
        <PanelButton
            variant={variant} placement={placement} className="tf-team-what-changed"
            icon="bx bx-bell" label={t("tf.team.what_changed")} count={team.unread.count}
        >
            <div className="tf-team-panel-heading">
                <span>{t("tf.team.what_changed")}</span>
                {notes.length > 0 && (
                    <Button className="tf-team-mark-all" size="small" kind="lowProfile" text={t("tf.team.mark_all_read")} onClick={() => void markAllSeen()} />
                )}
            </div>
            {notes.length === 0
                ? <NoItems icon="bx bx-check-circle" text={t("tf.team.nothing_changed")} />
                : notes.map((note) => <UnreadRow key={note.noteId} note={note} />)}
        </PanelButton>
    );
}

function UnreadRow({ note }: { note: UnreadNote }) {
    const when = formatAgo(note.changedAt, Date.now(), document.documentElement.lang || "en", t("tf.team.just_now"));
    const detail = note.by ? t("tf.team.changed_by", { name: note.by.name, when }) : when;
    return (
        <button type="button" className="dropdown-item tf-team-unread-row tf-team-jump" onClick={() => void openNoteFromTeam(note.noteId)}>
            <span className="tf-team-unread-dot" aria-hidden="true" />
            <span className="tf-team-row-text">
                <span className="tf-team-unread-title">{note.title || t("tf.team.untitled")}</span>
                <span className="tf-team-row-detail">{detail}</span>
            </span>
            {note.by && <Avatar person={note.by} size="sm" />}
        </button>
    );
}
