/**
 * The notices of Taskforce Notes in the main window, as persistent toasts: this Mac was
 * disconnected in Taskforce (with "Connect again"), the notebook is no longer one person's, an
 * update is on its way after a sync version change, and "Restart to update" once it is downloaded.
 */
import "./notice.css";

import type { TfDesktopInfo } from "@triliumnext/commons";

import toast from "../../services/toast.js";
import { getTfDesktopApi, noticeFor, type TfNoticeKind, tt } from "./state.js";

const TOAST_ID = "tf-desktop-notice";

let shown: TfNoticeKind = null;

/** Starts following the connection state. Does nothing outside Taskforce Notes. */
export function startTfDesktopNotice() {
    const api = getTfDesktopApi();
    if (!api) {
        return;
    }
    void api.getInfo().then(showNotice).catch(() => {});
    api.onState(showNotice);
}

export function showNotice(info: TfDesktopInfo | null) {
    const api = getTfDesktopApi();
    const kind = noticeFor(info);
    if (kind === shown) {
        return;
    }
    shown = kind;
    if (!kind || !api) {
        toast.closePersistent(TOAST_ID);
        return;
    }
    switch (kind) {
        case "revoked":
        case "not_eligible":
            toast.showPersistent({
                id: TOAST_ID,
                icon: "bx bx-unlink",
                message: kind === "revoked" ? tt("revoked_notice") : tt("not_eligible_notice"),
                buttons: [ { text: tt("button_connect_again"), onClick: () => api.showConnect() } ]
            });
            break;
        case "update_on_its_way":
            toast.showPersistent({ id: TOAST_ID, icon: "bx bx-download", message: tt("update_on_its_way") });
            break;
        case "update_ready":
            toast.showPersistent({
                id: TOAST_ID,
                icon: "bx bx-revision",
                message: tt("update_ready"),
                buttons: [ { text: tt("button_restart_update"), onClick: () => api.restartToUpdate() } ]
            });
            break;
    }
}
