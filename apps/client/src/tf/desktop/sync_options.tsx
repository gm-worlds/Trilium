/**
 * Settings → Sync in Taskforce Notes. The sync address comes from the connect link and there is no
 * proxy to set, so upstream's form gives way to what the connection is: the notebook, the person,
 * the last sync, and "Disconnect this Mac", which forgets the device key and keeps the notes.
 */
import type { TfDesktopInfo } from "@triliumnext/commons";
import { useEffect, useState } from "preact/hooks";

import dialog from "../../services/dialog";
import { getCurrentLanguage } from "../../services/i18n";
import Button from "../../widgets/react/Button";
import { Card, OptionCardSection } from "../../widgets/react/Card";
import OptionsPageHeader from "../../widgets/type_widgets/options/components/OptionsPageHeader";
import { formatSyncTime, getTfDesktopApi, tt } from "./state";

const REFRESH_MS = 5000;

export default function TfDesktopSyncOptions() {
    const api = getTfDesktopApi();
    const [ info, setInfo ] = useState<TfDesktopInfo | null>(null);

    useEffect(() => {
        if (!api) {
            return;
        }
        const refresh = () => void api.getInfo().then(setInfo).catch(() => {});
        refresh();
        const interval = setInterval(refresh, REFRESH_MS);
        const off = api.onState(setInfo);
        return () => {
            clearInterval(interval);
            off();
        };
    }, [ api ]);

    if (!api || !info) {
        return <OptionsPageHeader />;
    }

    async function disconnect() {
        if (!api || !(await dialog.confirm(tt("settings_disconnect_confirm")))) {
            return;
        }
        await api.disconnect();
        setInfo(await api.getInfo());
    }

    const lastSync = formatSyncTime(info.lastSyncAt, getCurrentLanguage()) || tt("settings_never");

    return (
        <>
            <OptionsPageHeader title={tt("settings_title")} icon="bx bx-sync" />
            <Card heading={info.notebookName || tt("settings_notebook")} className="tf-desktop-sync">
                <OptionCardSection label={tt("settings_status")} name="tf-status">
                    <span class="tf-desktop-status">{statusText(info)}</span>
                </OptionCardSection>
                <OptionCardSection label={tt("settings_notebook")} name="tf-notebook">
                    <span>{info.notebookName}</span>
                </OptionCardSection>
                <OptionCardSection label={tt("settings_person")} name="tf-person">
                    <span>{info.userName}</span>
                </OptionCardSection>
                <OptionCardSection label={tt("settings_last_sync")} name="tf-last-sync">
                    <span>{lastSync}</span>
                </OptionCardSection>
                <OptionCardSection label={tt("settings_version")} name="tf-version">
                    <span>{tt("version_line", { version: info.appVersion, build: info.appBuild })}</span>
                </OptionCardSection>
            </Card>

            <Card>
                {info.connected ? (
                    <OptionCardSection
                        label={tt("settings_disconnect")}
                        description={`${tt("settings_disconnect_description")} ${tt("settings_remove_hint")}`}
                        name="tf-disconnect"
                    >
                        <Button text={tt("settings_disconnect")} icon="bx bx-unlink" size="micro" onClick={() => void disconnect()} />
                    </OptionCardSection>
                ) : (
                    <OptionCardSection label={tt("disconnected_title")} description={tt("disconnected_text")} name="tf-connect-again">
                        <Button text={tt("button_connect_again")} icon="bx bx-link" size="micro" onClick={() => api.showConnect()} />
                    </OptionCardSection>
                )}
                {info.update.state === "ready" && (
                    <OptionCardSection label={tt("update_ready")} name="tf-update">
                        <Button text={tt("button_restart_update")} icon="bx bx-revision" size="micro" kind="primary" onClick={() => api.restartToUpdate()} />
                    </OptionCardSection>
                )}
            </Card>
        </>
    );
}

export function statusText(info: TfDesktopInfo) {
    if (!info.connected) return tt("status_disconnected");
    if (info.stop === "device_revoked") return tt("status_revoked");
    if (info.stop === "not_eligible") return tt("status_not_eligible");
    if (info.stop === "sync_version") return tt("status_update");
    if (info.update.state === "downloading") return `${tt("status_syncing")}. ${tt("update_downloading")}`;
    return tt("status_syncing");
}
