/**
 * The touch tools of one phone navigator row, mounted by a `// tf:` hook in `NavigatorRow`: a
 * visible "more" button that opens the row's context menu, and the ids `navigator_drag.ts` reads
 * to move the row. Renders nothing outside Taskforce.
 */
import "./navigator_row_tools.css";

import { t } from "../../services/i18n.js";
import ActionButton from "../../widgets/react/ActionButton.js";
import { useTfBootstrap } from "../components.js";
import { openRowMenu } from "./navigator_drag.js";

export function TfNavigatorRowTools({ noteId, parentNoteId, notePath }: { noteId: string; parentNoteId: string | undefined; notePath: string }) {
    const bootstrap = useTfBootstrap();
    if (!bootstrap || !parentNoteId) {
        return null;
    }

    return (
        <span className="tf-row-tools" data-note-id={noteId} data-parent-note-id={parentNoteId} data-note-path={notePath}>
            <ActionButton
                className="tf-row-more"
                icon="bx bx-dots-horizontal-rounded"
                text={t("tf.row_more")}
                noTooltipOnTouch
                onClick={(e) => {
                    e.stopPropagation();
                    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(".mobile-navigator-row");
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    if (row) {
                        openRowMenu(row, { x: rect.left + rect.width / 2, y: rect.bottom });
                    }
                }}
            />
        </span>
    );
}
