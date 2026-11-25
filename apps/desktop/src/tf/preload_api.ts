/**
 * The renderer side of the Taskforce Notes connection (`window.electronApi.tfDesktop`). Only
 * marshals to the `tf-desktop-*` channels of `tf/index.ts`; in an upstream build no handler is
 * registered and the client never calls it (it checks `glob.tfDesktop` first).
 */
import type { ElectronTfDesktopApi, TfDesktopInfo, TfReplaceProgress } from "@triliumnext/commons";
import type { IpcRenderer, IpcRendererEvent } from "electron";

export function createTfDesktopApi(ipcRenderer: IpcRenderer): ElectronTfDesktopApi {
    const subscribe = <T>(channel: string, callback: (value: T) => void) => {
        const listener = (_event: IpcRendererEvent, value: T) => callback(value);
        ipcRenderer.on(channel, listener);
        return () => {
            ipcRenderer.removeListener(channel, listener);
        };
    };

    return {
        getInfo: () => ipcRenderer.invoke("tf-desktop-get-info"),
        checkLink: (link: string) => ipcRenderer.invoke("tf-desktop-check-link", link),
        checkStockTrilium: () => ipcRenderer.invoke("tf-desktop-check-stock"),
        bringStockNotes: () => ipcRenderer.invoke("tf-desktop-bring-stock"),
        onReplaceProgress: (callback) => subscribe<TfReplaceProgress>("tf-desktop-replace-progress", callback),
        connect: () => ipcRenderer.invoke("tf-desktop-connect"),
        startFresh: () => ipcRenderer.invoke("tf-desktop-start-fresh"),
        disconnect: () => ipcRenderer.invoke("tf-desktop-disconnect"),
        openNotesOffline: () => ipcRenderer.send("tf-desktop-open-offline"),
        showConnect: () => ipcRenderer.send("tf-desktop-show-connect"),
        restartToUpdate: () => ipcRenderer.send("tf-desktop-restart-to-update"),
        onLink: (callback) => subscribe<string>("tf-desktop-link", callback),
        onState: (callback) => subscribe<TfDesktopInfo>("tf-desktop-state", callback)
    };
}
