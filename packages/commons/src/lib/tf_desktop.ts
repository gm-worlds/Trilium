/**
 * Shared types of the Taskforce Notes desktop app (`TF_DESKTOP=1`): the fork's Electron build that
 * syncs with one Taskforce notebook. The main process owns the connection (`apps/desktop/src/tf/`);
 * the renderer reaches it through `window.electronApi.tfDesktop` ({@link ElectronTfDesktopApi}).
 */

/** Why syncing stopped until the person acts. */
export type TfDesktopStopReason = "device_revoked" | "not_eligible" | "sync_version";

export type TfDesktopUpdateState = "off" | "idle" | "checking" | "downloading" | "ready";

/** What the connect screen, the Settings page and the notice show. */
export interface TfDesktopInfo {
    /** Whether this Mac has a device key. */
    connected: boolean;
    /** Whether this Mac holds a notebook's notes (also after a disconnect). */
    hasLocalNotes: boolean;
    notebookName: string;
    userName: string;
    /** The notebook's address, without any path. */
    serverOrigin: string;
    /** UTC `YYYY-MM-DD HH:mm:ss.SSSZ` of the last finished sync, or `""`. */
    lastSyncAt: string;
    stop: TfDesktopStopReason | null;
    appVersion: string;
    appBuild: number;
    syncVersion: number;
    update: { state: TfDesktopUpdateState; version?: string };
    /** A connect link that arrived through the `taskforce-notes:` scheme and is not used yet. */
    pendingLink: string | null;
}

/** Where the notes of a stock Trilium on this Mac are, when there is one. */
export interface TfStockTrilium {
    found: boolean;
    sizeBytes?: number;
    running: boolean;
}

export type TfConnectMode = "new" | "reconnect" | "other_notebook";

export type TfConnectCheck =
    | {
        ok: true;
        server: string;
        mode: TfConnectMode;
        /** The link allows replacing the notebook with the notes of a stock Trilium. */
        replaceAllowed: boolean;
        /** The notebook's name and its person, when the gateway's update answer carries them. */
        notebookName?: string;
        userName?: string;
        stockTrilium: TfStockTrilium | null;
    }
    | {
        ok: false;
        reason: "bad_link" | "code_refused" | "not_eligible" | "version_mismatch" | "network" | "server";
        message?: string;
        /** With `version_mismatch`: where to get the build that matches the notebook. */
        downloadUrl?: string;
        downloadVersion?: string;
    };

export interface TfReplaceProgress {
    phase: "copying" | "sending" | "importing";
    /** Bytes (sending) or pages (copying) done, of `total`. */
    done: number;
    total: number;
}

export type TfDesktopResult<T = object> = ({ ok: true } & T) | { ok: false; message: string };

export interface ElectronTfDesktopApi {
    getInfo(): Promise<TfDesktopInfo>;
    /** Reads a connect link and asks the notebook whether this app may connect with it. */
    checkLink(link: string): Promise<TfConnectCheck>;
    /** Asks again whether a stock Trilium is running (after the person was asked to quit it). */
    checkStockTrilium(): Promise<TfStockTrilium | null>;
    /** Replaces the notebook with a copy of the stock Trilium's notes, for the checked link. */
    bringStockNotes(): Promise<TfDesktopResult<{ notes: number }>>;
    onReplaceProgress(callback: (progress: TfReplaceProgress) => void): () => void;
    /** Uses the checked link: this Mac gets its device key and starts syncing. */
    connect(): Promise<TfDesktopResult>;
    /**
     * For a link of another notebook on a Mac that holds notes: keeps the notes on this Mac as a
     * backup file and restarts the app empty, which then continues with the link.
     */
    startFresh(): Promise<TfDesktopResult>;
    /** Forgets the device key; the notes stay on this Mac. */
    disconnect(): Promise<void>;
    /** From the connect screen of a disconnected Mac: opens the notes without syncing. */
    openNotesOffline(): void;
    /** Opens the connect screen (from the notice or Settings). */
    showConnect(): void;
    restartToUpdate(): void;
    /** A connect link arrived through the `taskforce-notes:` scheme. */
    onLink(callback: (link: string) => void): () => void;
    /** The connection, sync stop or update state changed. */
    onState(callback: (info: TfDesktopInfo) => void): () => void;
}
