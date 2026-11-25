/**
 * The visible pieces of the reach features that upstream widgets mount. Each renders nothing
 * unless the notebook runs embedded.
 */
import type FNote from "../../entities/fnote.js";
import { t } from "../../services/i18n.js";
import { FormListItem } from "../../widgets/react/FormList.js";
import { useTfBootstrap } from "../components.js";
import OtherNotebooks from "./search/OtherNotebooks.js";
import ShareMarker from "./share/ShareMarker.js";
import EmbedStatus from "./voice/EmbedStatus.js";

/** Under an embed's content: the transcript's progress or failure for an attachment embed. */
export function TfEmbedStatus({ viewScope }: { viewScope?: { attachmentId?: string } }) {
    const bootstrap = useTfBootstrap();
    const attachmentId = viewScope?.attachmentId;
    return bootstrap && attachmentId ? <EmbedStatus attachmentId={attachmentId} /> : null;
}

/** "Share link…" in the note menu. */
export function TfShareLinkRow({ note }: { note: FNote | null | undefined }) {
    const bootstrap = useTfBootstrap();
    if (!bootstrap || !note || note.noteId === "root" || note.noteId.startsWith("_")) {
        return null;
    }
    return (
        <FormListItem
            icon="bx bx-link"
            className="tf-share-link-row"
            onClick={(e) => {
                // Read now: the menu closes, and its item leaves the page, before the dialog loads.
                const opener = openerOf(e.currentTarget as HTMLElement);
                void import("./share/ShareDialog.js").then(({ openShareDialog }) => openShareDialog(note, opener));
            }}
        >{t("tf.reach.share_link_menu")}</FormListItem>
    );
}

/** The title row's "Shared until <date>". */
export function TfShareMarker() {
    const bootstrap = useTfBootstrap();
    return bootstrap ? <ShareMarker /> : null;
}

/** "In your other notebooks" under the quick search's and the full search's results. */
export function TfOtherNotebooks({ query, variant, onOpen }: { query: string; variant: "menu" | "list"; onOpen?: () => void }) {
    const bootstrap = useTfBootstrap();
    return bootstrap ? <OtherNotebooks query={query} variant={variant} onOpen={onOpen} /> : null;
}

/** The control to give the focus back to: `element`, or the toggle of the menu it sits in. */
export function openerOf(element: Element | null): HTMLElement | null {
    if (!(element instanceof HTMLElement) || element === document.body) {
        return openMenuToggle();
    }
    if (element.closest(".dropdown-menu, .tn-dropdown-portal")) {
        return element.closest(".dropdown")?.querySelector<HTMLElement>("[data-bs-toggle='dropdown'], .dropdown-toggle") ?? openMenuToggle();
    }
    return element;
}

function openMenuToggle() {
    return document.querySelector<HTMLElement>(":is([data-bs-toggle='dropdown'], .dropdown-toggle)[aria-expanded='true']");
}
