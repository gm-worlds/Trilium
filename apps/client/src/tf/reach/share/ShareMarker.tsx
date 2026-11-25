/**
 * "Shared until <date>" in the note's title row while the note has a live share link; pressing it
 * opens the share dialog. Asks only about notes the engine shares (a child of `_share`, which a
 * first link makes), and again whenever the dialog or another person changes the links.
 */
import { useEffect, useState } from "preact/hooks";

import type FNote from "../../../entities/fnote.js";
import { t } from "../../../services/i18n.js";
import { Badge } from "../../../widgets/react/Badge.js";
import { useNoteContext, useTriliumEvent } from "../../../widgets/react/hooks.js";
import { useTfBootstrap } from "../../components.js";
import { listShareLinks, onShareChanged } from "./api.js";
import { formatDay } from "./format.js";
import { markerFor, type ShareMarker as Marker } from "./model.js";

export default function ShareMarker() {
    const { note } = useNoteContext();
    const bootstrap = useTfBootstrap();
    const [ marker, setMarker ] = useState<Marker>(null);
    const [ version, setVersion ] = useState(0);
    const noteId = note?.noteId;

    useEffect(() => {
        if (!bootstrap || !note || !isDirectlyShared(note)) {
            setMarker(null);
            return;
        }
        let cancelled = false;
        void listShareLinks(note.noteId)
            .then((links) => !cancelled && setMarker(markerFor(links)))
            .catch(() => !cancelled && setMarker(null));
        return () => {
            cancelled = true;
        };
    }, [ bootstrap, noteId, version ]);

    useEffect(() => onShareChanged((changed) => {
        if (changed === noteId) setVersion((v) => v + 1);
    }), [ noteId ]);

    useTriliumEvent("entitiesReloaded", ({ loadResults }) => {
        if (noteId && loadResults.getBranchRows().some((branch) => branch.noteId === noteId && branch.parentNoteId === "_share")) {
            setVersion((v) => v + 1);
        }
    });

    if (!marker || !note) {
        return null;
    }

    const text = marker.kind === "until"
        ? t("tf.reach.shared_until", { when: formatDay(marker.until) })
        : t("tf.reach.shared_no_end");
    return (
        <Badge
            className="tf-share-marker"
            icon="bx bx-link"
            text={text}
            onClick={(e) => {
                const opener = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
                void import("./ShareDialog.js").then(({ openShareDialog }) => openShareDialog(note, opener));
            }}
        />
    );
}

function isDirectlyShared(note: FNote) {
    return note.getParentNoteIds().includes("_share");
}
