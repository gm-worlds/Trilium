/**
 * The few visible pieces of the Taskforce embedding. Each renders nothing unless the notebook runs
 * embedded, so the upstream layouts and dialogs can mount them unconditionally.
 */
import "./tf.css";

import { useSyncExternalStore } from "preact/compat";
import { useEffect, useState } from "preact/hooks";

import { t } from "../services/i18n.js";
import server from "../services/server.js";
import { LaunchBarActionButton, LaunchBarContext } from "../widgets/launch_bar/launch_bar_widgets.js";
import { PropertySheetItem } from "../widgets/react/PropertySheet.js";
import { getTfBridge } from "./bridge.js";
import { getTfBootstrap, subscribeTf } from "./state.js";

const PROTECTED_POLL_MS = 15_000;

export function useTfBootstrap() {
    return useSyncExternalStore(subscribeTf, getTfBootstrap);
}

/**
 * Hands the person back to Taskforce's tab and project switcher.
 *
 * The layouts mount it through `ReactWrappedWidget`, which places only what the first render
 * produced, and the bootstrap arrives after that render. The `tf-slot` element is therefore always
 * rendered (`display: contents`) and the button appears inside it later.
 */
export function TaskforceButton({ isHorizontalLayout }: { isHorizontalLayout: boolean }) {
    const bootstrap = useTfBootstrap();

    return (
        <div className="tf-slot tf-taskforce-slot">
            {bootstrap && (
                <LaunchBarContext.Provider value={{ isHorizontalLayout }}>
                    <LaunchBarActionButton
                        className="tf-taskforce-button"
                        data-tf-taskforce="true"
                        aria-label={t("tf.taskforce")}
                        icon="tf-taskforce-mark"
                        text={t("tf.back_to_taskforce")}
                        onClick={() => getTfBridge()?.notify("switcher.open", {})}
                    />
                </LaunchBarContext.Provider>
            )}
        </div>
    );
}

interface ProtectedState {
    unlocked: boolean;
    by: { id: string; name: string } | null;
}

/** Tells everyone else that protected notes were opened for the whole notebook, and by whom. */
export function TfProtectedNotice() {
    const bootstrap = useTfBootstrap();
    const [ state, setState ] = useState<ProtectedState | null>(null);

    useEffect(() => {
        if (!bootstrap) {
            return;
        }

        let cancelled = false;
        const refresh = async () => {
            try {
                const next = await server.getWithSilentNotFound<ProtectedState>("tf/protected");
                if (!cancelled) {
                    setState(next ?? null);
                }
            } catch {
                // A failed poll keeps the last known state.
            }
        };

        void refresh();
        const timer = setInterval(refresh, PROTECTED_POLL_MS);
        window.addEventListener("focus", refresh);
        return () => {
            cancelled = true;
            clearInterval(timer);
            window.removeEventListener("focus", refresh);
        };
    }, [ bootstrap ]);

    const shown = !!bootstrap && !!state?.unlocked && state.by?.id !== bootstrap.user?.id;
    const text = state?.by ? t("tf.protected_open_by", { name: state.by.name }) : t("tf.protected_open");
    return (
        <div className="tf-slot">
            {shown && (
                <div className="tf-protected-notice" role="status" title={text}>
                    <span className="bx bx-lock-open-alt" aria-hidden="true" />
                    <span>{text}</span>
                </div>
            )}
        </div>
    );
}

/** The About dialog's line naming the fork and its source (AGPL-3.0, section 13). */
export function TfAboutLine() {
    const bootstrap = useTfBootstrap();
    if (!bootstrap) {
        return null;
    }

    return (
        <PropertySheetItem label={t("tf.fork_label")}>
            <a className="tn-link" href={bootstrap.sourceUrl} target="_blank" rel="noopener noreferrer">
                {t("tf.fork_text")}
            </a>
            {" "}({bootstrap.engineVersion})
        </PropertySheetItem>
    );
}
