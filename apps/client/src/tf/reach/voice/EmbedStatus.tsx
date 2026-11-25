/**
 * The line under an audio embed while its transcript is made, or why it could not be made, with
 * "Try again" where that can help. Reads the attachment's status from `transcribe.ts`.
 */
import "./EmbedStatus.css";

import { useRef, useSyncExternalStore } from "preact/compat";

import froca from "../../../services/froca.js";
import { t } from "../../../services/i18n.js";
import Button from "../../../widgets/react/Button.js";
import { findTextEditorAround } from "../../../widgets/type_widgets/text/editable_embed.js";
import { canRetry, type EmbedVoiceStatus, getEmbedVoiceStatus, subscribeEmbedVoiceStatus, withFullStop } from "./transcribe.js";

export default function EmbedStatus({ attachmentId }: { attachmentId: string }) {
    const status = useSyncExternalStore(subscribeEmbedVoiceStatus, () => getEmbedVoiceStatus(attachmentId));
    const rootRef = useRef<HTMLDivElement>(null);
    if (!status) {
        return null;
    }

    const retry = async () => {
        const attachment = await froca.getAttachment(attachmentId, true);
        if (!attachment) return;
        const { makeTranscriptOfAttachment } = await import("./session.js");
        await makeTranscriptOfAttachment(attachment, findTextEditorAround(rootRef.current) ?? null);
    };

    return (
        <div ref={rootRef} className={`tf-voice-embed-status state-${status.state}`} role="status" aria-live="polite" contentEditable={false}>
            {status.state === "working"
                ? <>
                    <span className="bx bx-loader-alt bx-spin" aria-hidden="true" />
                    <span>{t("tf.reach.writing_transcript")}</span>
                </>
                : <>
                    <span className="bx bx-info-circle" aria-hidden="true" />
                    <span className="tf-voice-embed-message">{describeFailure(status)}</span>
                    {canRetry(status.kind) && (
                        <Button className="tf-voice-embed-retry" size="small" text={t("tf.reach.try_again")}
                            onClick={(e) => {
                                e.stopPropagation();
                                void retry();
                            }} />
                    )}
                </>}
        </div>
    );
}

export function describeFailure(status: Extract<EmbedVoiceStatus, { state: "error" }>) {
    switch (status.kind) {
        case "budget":
            return status.message
                ? withFullStop(t("tf.reach.transcript_budget", { message: status.message }))
                : t("tf.reach.transcript_failed");
        case "not_configured":
            return status.message ? withFullStop(status.message) : t("tf.reach.transcript_not_configured");
        case "too_long":
            return t("tf.reach.transcript_too_long");
        case "empty":
            return t("tf.reach.transcript_empty");
        case "unsupported":
            return status.message ?? t("tf.reach.transcript_unsupported");
        default:
            return t("tf.reach.transcript_failed");
    }
}
