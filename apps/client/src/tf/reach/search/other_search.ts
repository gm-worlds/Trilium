/**
 * Search in the person's other notebooks (`GET search?q=&limit=`, contract "Search"): the
 * excerpt as safe HTML, and a debounced search that a newer query cancels.
 */
import { tfFetch } from "../../gateway.js";

export interface NoteSearchHit {
    notebookId: string;
    noteId: string;
    title: string;
    path: string;
    excerpt: string;
    projectId: string;
    projectName: string;
    notebookName: string;
    href: string;
    here?: boolean;
}

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEBOUNCE_MS = 250;
export const SEARCH_LIMIT = 8;

const MARK_START = "[[";
const MARK_STOP = "]]";

/** The excerpt as HTML: everything escaped, the API's `[[…]]` matches as `<mark>`. */
export function excerptToHtml(excerpt: string) {
    let html = "";
    let rest = excerpt;
    while (rest.length) {
        const start = rest.indexOf(MARK_START);
        if (start === -1) {
            html += escapeHtml(rest);
            break;
        }
        const stop = rest.indexOf(MARK_STOP, start + MARK_START.length);
        if (stop === -1) {
            html += escapeHtml(rest);
            break;
        }
        html += escapeHtml(rest.slice(0, start));
        html += `<mark>${escapeHtml(rest.slice(start + MARK_START.length, stop))}</mark>`;
        rest = rest.slice(stop + MARK_STOP.length);
    }
    return html;
}

function escapeHtml(text: string) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The hits of other notebooks: the ones here are left to Trilium's own results. */
export function otherNotebookHits(hits: NoteSearchHit[] | null | undefined) {
    return (hits ?? []).filter((hit) => !hit.here && typeof hit.href === "string" && hit.href.startsWith("/"));
}

export type SearchFetcher = (query: string, signal: AbortSignal) => Promise<NoteSearchHit[]>;

export const fetchOtherNotebookHits: SearchFetcher = async (query, signal) => {
    const answer = await tfFetch<{ query: string; hits: NoteSearchHit[] }>(
        `search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`, { signal });
    return otherNotebookHits(answer?.hits);
};

/**
 * Runs `fetcher` 250 ms after the last query of at least two characters, aborting the request of
 * an older query; a failure or a shorter query yields no hits, never an error.
 */
export function createDebouncedSearch(fetcher: SearchFetcher, onHits: (query: string, hits: NoteSearchHit[]) => void) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;
    let latest = "";

    const cancel = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        controller?.abort();
        controller = null;
    };

    return {
        update(raw: string) {
            const query = raw.trim();
            if (query === latest) {
                return;
            }
            latest = query;
            cancel();
            if (query.length < SEARCH_MIN_CHARS) {
                onHits(query, []);
                return;
            }
            timer = setTimeout(async () => {
                timer = null;
                const own = new AbortController();
                controller = own;
                try {
                    const hits = await fetcher(query, own.signal);
                    if (!own.signal.aborted && query === latest) {
                        onHits(query, hits);
                    }
                } catch {
                    if (!own.signal.aborted && query === latest) {
                        onHits(query, []);
                    }
                } finally {
                    if (controller === own) {
                        controller = null;
                    }
                }
            }, SEARCH_DEBOUNCE_MS);
        },
        cancel() {
            latest = "";
            cancel();
        }
    };
}
