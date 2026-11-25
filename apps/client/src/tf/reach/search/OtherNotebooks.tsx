/**
 * "In your other notebooks" under Trilium's own search results: hits from the person's other
 * notebooks, each opening that notebook at the note through the host (`open { href }`). Renders
 * nothing until it has hits, so it never delays or moves Trilium's results, and nothing when the
 * search fails.
 */
import "./OtherNotebooks.css";

import { useEffect, useMemo, useState } from "preact/hooks";

import { t } from "../../../services/i18n.js";
import { getTfBridge } from "../../bridge.js";
import { createDebouncedSearch, excerptToHtml, fetchOtherNotebookHits, type NoteSearchHit } from "./other_search.js";

export default function OtherNotebooks({ query, variant, onOpen }: {
    query: string;
    /** `menu`: rows of the quick search popup; `list`: below the full search's cards. */
    variant: "menu" | "list";
    onOpen?: () => void;
}) {
    const [ hits, setHits ] = useState<NoteSearchHit[]>([]);
    const search = useMemo(() => createDebouncedSearch(fetchOtherNotebookHits, (_query, found) => setHits(found)), []);

    useEffect(() => search.update(query), [ query ]);
    useEffect(() => () => search.cancel(), []);

    if (!hits.length) {
        return null;
    }

    const open = (hit: NoteSearchHit) => {
        getTfBridge()?.notify("open", { href: hit.href });
        onOpen?.();
    };

    return (
        <section className={`tf-other-notebooks variant-${variant}`} aria-label={t("tf.reach.other_notebooks")}>
            {variant === "menu"
                ? <h6 className="dropdown-header tf-other-notebooks-heading">{t("tf.reach.other_notebooks")}</h6>
                : <h5 className="tf-other-notebooks-heading">{t("tf.reach.other_notebooks")}</h5>}
            {hits.map((hit) => (
                <button
                    key={`${hit.notebookId}:${hit.noteId}`}
                    type="button"
                    className={variant === "menu" ? "dropdown-item tf-other-hit" : "tf-other-hit"}
                    data-href={hit.href}
                    onClick={() => open(hit)}
                >
                    <span className="tf-other-hit-title">
                        <span className="bx bx-book-open" aria-hidden="true" />
                        <span>{hit.title}</span>
                    </span>
                    <span className="tf-other-hit-where">
                        {[ hit.projectName, hit.path ].filter(Boolean).join(" · ")}
                    </span>
                    {hit.excerpt && (
                        <span className="tf-other-hit-excerpt" dangerouslySetInnerHTML={{ __html: excerptToHtml(hit.excerpt) }} />
                    )}
                </button>
            ))}
        </section>
    );
}
