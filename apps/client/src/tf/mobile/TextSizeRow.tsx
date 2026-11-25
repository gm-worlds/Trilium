/**
 * The "Text size" row of the note menu (minus, percentage, plus, reset), mounted by a `// tf:` hook
 * in `NoteContextMenu`. For text and code notes inside Taskforce; it changes the same per-person
 * size a pinch does (`text_size.ts`).
 */
import "./TextSizeRow.css";

import { useSyncExternalStore } from "preact/compat";

import type FNote from "../../entities/fnote.js";
import { t } from "../../services/i18n.js";
import ActionButton from "../../widgets/react/ActionButton.js";
import { FormListCustomItem } from "../../widgets/react/FormList.js";
import { useTfBootstrap } from "../components.js";
import { TEXT_SCALE_MAX, TEXT_SCALE_MIN, formatTextScale } from "./gestures.js";
import { getTextScale, setTextScale, stepTextScale, subscribeTextScale } from "./text_size.js";

export function TfTextSizeRow({ note }: { note: FNote | null | undefined }) {
    const bootstrap = useTfBootstrap();
    const scale = useSyncExternalStore(subscribeTextScale, getTextScale);
    if (!bootstrap || !note || (note.type !== "text" && note.type !== "code")) {
        return null;
    }

    return (
        <FormListCustomItem>
            {/* The buttons keep the menu open, so the size can be stepped several times. */}
            <div className="tf-text-size-row" onClick={(e) => e.stopPropagation()}>
                <span className="tf-text-size-label">
                    <span className="bx bx-font-size" aria-hidden="true" />
                    {t("tf.text_size")}
                </span>
                <span className="tf-text-size-controls">
                    <ActionButton icon="bx bx-minus" text={t("tf.text_smaller")} noTooltipOnTouch
                        disabled={scale <= TEXT_SCALE_MIN} onClick={() => stepTextScale(-1)} />
                    <output className="tf-text-size-value" aria-live="polite">{formatTextScale(scale)}</output>
                    <ActionButton icon="bx bx-plus" text={t("tf.text_larger")} noTooltipOnTouch
                        disabled={scale >= TEXT_SCALE_MAX} onClick={() => stepTextScale(1)} />
                    <ActionButton icon="bx bx-reset" text={t("tf.text_reset")} noTooltipOnTouch
                        disabled={scale === 1} onClick={() => setTextScale(1)} />
                </span>
            </div>
        </FormListCustomItem>
    );
}
