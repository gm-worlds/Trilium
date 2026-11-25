/**
 * Who wrote what: "Edited by NAME, 5 min ago" under a note's title and atop its comments, and the
 * author of each revision in the revisions dialog, with a "By" filter once several people have
 * revisions. Revisions without a known author show nothing.
 */
import { useEffect, useState } from "preact/hooks";

import { t } from "../../services/i18n.js";
import FormSelect from "../../widgets/react/FormSelect.js";
import { useNoteContext } from "../../widgets/react/hooks.js";
import { bumpTfTeam } from "./hooks.js";
import { formatAgo } from "./model.js";
import { getTeam, loadActivity, loadRevisionAuthors, useTeam } from "./store.js";

const EVERYONE = "";

export function AuthorLine({ noteId, className }: { noteId: string; className?: string }) {
    const team = useTeam();
    const activity = team.activity.get(noteId);
    const [ , setTick ] = useState(0);

    useEffect(() => {
        void loadActivity(noteId);
        const timer = window.setInterval(() => setTick((value) => value + 1), 30_000);
        return () => window.clearInterval(timer);
    }, [ noteId ]);

    if (!activity?.lastEditedBy) {
        return null;
    }
    const locale = document.documentElement.lang || "en";
    const when = formatAgo(activity.lastEditedAt, Date.now(), locale, t("tf.team.just_now"));
    const full = activity.lastEditedAt ? new Date(activity.lastEditedAt).toLocaleString(locale) : "";
    return (
        <span className={`tf-team-author-line ${className ?? ""}`} title={full}>
            {t("tf.team.edited_by", { name: activity.lastEditedBy.name, when })}
        </span>
    );
}

/** The `title-details` slot: the author line after the created and modified dates. */
export function TitleDetailsTeam() {
    const { note } = useNoteContext();
    const team = useTeam();
    const noteId = note?.noteId;
    if (!noteId || noteId.startsWith("_") || !team.activity.get(noteId)?.lastEditedBy) {
        return noteId && !noteId.startsWith("_") ? <AuthorLoader noteId={noteId} /> : null;
    }
    return (
        <>
            <span className="tf-team-title-sep" aria-hidden="true">{" • "}</span>
            <li className="tf-team-title-author"><AuthorLine noteId={noteId} /></li>
        </>
    );
}

function AuthorLoader({ noteId }: { noteId: string }) {
    useEffect(() => {
        void loadActivity(noteId);
    }, [ noteId ]);
    return null;
}

//#region Revisions

let filter: { noteId: string; personId: string } | null = null;

/** The `filterRevisions` hook: the revisions of the person picked in "By", or all. */
export function filterRevisions<T extends { revisionId?: string }>(noteId: string | undefined, revisions: T[]): T[] {
    if (!noteId || !filter || filter.noteId !== noteId || filter.personId === EVERYONE) {
        return revisions;
    }
    const authors = getTeam().revisionAuthors.get(noteId) ?? {};
    return revisions.filter((revision) => revision.revisionId && authors[revision.revisionId]?.id === filter?.personId);
}

/** The `revision-author` slot of a revision row. */
export function RevisionAuthor({ noteId, revisionId }: { noteId?: string; revisionId?: string }) {
    const team = useTeam();
    const author = noteId && revisionId ? team.revisionAuthors.get(noteId)?.[revisionId] : undefined;
    if (!author) {
        return null;
    }
    return <span className="revision-item-author tf-team-revision-author">{t("tf.team.by_name", { name: author.name })}</span>;
}

/** The `revision-filter` slot above the revision list. */
export function RevisionFilter({ noteId }: { noteId?: string }) {
    const team = useTeam();
    const [ value, setValue ] = useState(EVERYONE);

    useEffect(() => {
        filter = null;
        setValue(EVERYONE);
        if (noteId) {
            void loadRevisionAuthors(noteId);
        }
        return () => {
            filter = null;
        };
    }, [ noteId ]);

    const authors = noteId ? team.revisionAuthors.get(noteId) ?? {} : {};
    const people = new Map<string, string>();
    for (const author of Object.values(authors)) {
        people.set(author.id, author.name);
    }
    if (!noteId || people.size < 2) {
        return null;
    }

    const values = [
        { id: EVERYONE, name: t("tf.team.everyone") },
        ...[ ...people ].map(([ id, name ]) => ({ id, name })).toSorted((a, b) => a.name.localeCompare(b.name))
    ];
    return (
        <label className="tf-team-revision-filter">
            <span>{t("tf.team.by")}</span>
            <FormSelect
                values={values}
                keyProperty="id"
                titleProperty="name"
                currentValue={value}
                onChange={(next) => {
                    setValue(next);
                    filter = { noteId, personId: next };
                    bumpTfTeam();
                }}
            />
        </label>
    );
}

//#endregion
