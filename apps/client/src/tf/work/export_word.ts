/**
 * "Word document" in the export dialog and "Download as Word" in the note menu, through the engine's
 * `GET /api/tf/export/docx/:noteId[?children=1]`. Imported statically by the export dialog, so it
 * stays light.
 */
import froca from "../../services/froca.js";
import { t } from "../../services/i18n.js";
import open from "../../services/open.js";
import toast from "../../services/toast.js";
import { fetchWithRefresh } from "../gateway.js";
import { isTfEmbedded } from "../state.js";

export const DOCX_FORMAT = "docx";

interface ExportFormatLike {
    value: string;
    name: string;
    description: string;
    icon: string;
}

/** The export dialog's formats with Word added while embedded. */
export function withTfExportFormats<T extends ExportFormatLike>(formats: T[]): T[] {
    if (!isTfEmbedded()) {
        return formats;
    }
    return [ ...formats, {
        value: DOCX_FORMAT,
        name: t("tf.work.export_word_name"),
        description: t("tf.work.export_word_description"),
        icon: "bx bxs-file-doc"
    } as T ];
}

/** The dialog's one-line summary for Word, or `null` for the other formats. */
export function tfExportResultText(type: "subtree" | "single", format: string): string | null {
    if (format !== DOCX_FORMAT) {
        return null;
    }
    return type === "subtree" ? t("tf.work.export_word_subtree") : t("tf.work.export_word_single");
}

/** Runs a Word export from the dialog; returns `false` for any other format. */
export function tfExportBranch(branchId: string, type: string, format: string): boolean {
    if (format !== DOCX_FORMAT) {
        return false;
    }
    const noteId = froca.getBranch(branchId, true)?.noteId;
    if (noteId) {
        void downloadWord(noteId, type === "subtree");
    }
    return true;
}

/**
 * Downloads the note (and with `withChildren` everything under it) as one .docx file. The engine
 * builds it first (`POST`, so a failure is a toast here), then the frame fetches it by navigating
 * to its one-time address, the way upstream exports download.
 */
export async function downloadWord(noteId: string, withChildren: boolean) {
    toast.showMessage(t("tf.work.export_word_started"));
    try {
        const url = `api/tf/export/docx/${encodeURIComponent(noteId)}${withChildren ? "?children=1" : ""}`;
        const response = await fetchWithRefresh(() => fetch(url, {
            method: "POST",
            credentials: "same-origin",
            headers: { "x-csrf-token": (window.glob as { csrfToken?: string } | undefined)?.csrfToken ?? "" }
        }));
        if (!response.ok) {
            throw new Error(`export answered ${response.status}`);
        }
        const { token } = await response.json() as { token: string };
        open.download(`api/tf/export/docx/file/${encodeURIComponent(token)}`);
    } catch {
        toast.showError(t("tf.work.export_word_failed"));
    }
}
