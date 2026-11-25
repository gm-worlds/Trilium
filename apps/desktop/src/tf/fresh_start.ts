/**
 * Moving a notebook's notes aside so this Mac can connect to another notebook. The move happens on
 * the next start, before the database is opened (`prelude.ts`): the app writes a marker with the
 * connect link, restarts, the database files are renamed into `backup/`, and the connect screen
 * continues with the link on an empty database.
 */
import fs from "fs";
import path from "path";

const MARKER = "tf-fresh-start.json";
const PENDING = "tf-pending-link.json";
const DB_FILES = [ "document.db", "document.db-wal", "document.db-shm" ];

/**
 * What the connect screen continues with after the restart: a link whose code is still unused, or
 * the answer of a code that was already redeemed (the notebook was replaced since this Mac synced).
 */
export interface TfPendingConnect {
    link?: string;
    redeemed?: unknown;
}

export function writeFreshStartMarker(dataDir: string, pending: TfPendingConnect, notebookName: string) {
    fs.writeFileSync(path.join(dataDir, MARKER), JSON.stringify({ ...pending, notebookName, at: new Date().toISOString() }), { mode: 0o600 });
}

/**
 * Runs the move asked for by {@link writeFreshStartMarker}, if any. Returns the backup file. The
 * marker is removed first, so a failing move cannot loop the app; the link survives as a pending
 * link either way.
 */
export function runFreshStartIfAsked(dataDir: string, now = new Date()): string | null {
    const markerPath = path.join(dataDir, MARKER);
    if (!fs.existsSync(markerPath)) {
        return null;
    }
    let marker: TfPendingConnect & { notebookName?: string } = {};
    try {
        marker = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    } catch {
        // An unreadable marker still asks for the move.
    }
    fs.rmSync(markerPath, { force: true });
    if (marker.link || marker.redeemed) {
        fs.writeFileSync(path.join(dataDir, PENDING), JSON.stringify({ link: marker.link, redeemed: marker.redeemed }), { mode: 0o600 });
    }

    const backupDir = path.join(dataDir, "backup");
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const stamp = now.toISOString().replace(/[:.]/g, "-");
    const label = (marker.notebookName ?? "notebook").replace(/[^\p{L}\p{N} _-]+/gu, "").trim().slice(0, 60) || "notebook";
    const base = path.join(backupDir, `before-connecting ${label} ${stamp}.db`);
    for (const file of DB_FILES) {
        const from = path.join(dataDir, file);
        if (fs.existsSync(from)) {
            fs.renameSync(from, base + file.slice("document.db".length));
        }
    }
    return base;
}

/** What a fresh start left to continue with, read once. */
export function takePendingConnect(dataDir: string): TfPendingConnect {
    const pendingPath = path.join(dataDir, PENDING);
    if (!fs.existsSync(pendingPath)) {
        return {};
    }
    try {
        const { link, redeemed } = JSON.parse(fs.readFileSync(pendingPath, "utf-8")) as TfPendingConnect;
        return { link: typeof link === "string" ? link : undefined, redeemed: redeemed ?? undefined };
    } catch {
        return {};
    } finally {
        fs.rmSync(pendingPath, { force: true });
    }
}
