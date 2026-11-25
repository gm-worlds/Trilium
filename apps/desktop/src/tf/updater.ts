/**
 * Updates of Taskforce Notes through Electron's `autoUpdater` (Squirrel.Mac). The feed is the
 * notebook's own gateway, `<syncServerHost>/__tf/desktop/squirrel?build=<appBuild>` with the device
 * key: it answers 204 while this build is the newest one with the engine's sync version, else the
 * signed zip of that build. Checked at start and every hour; the download runs in the background
 * and the app offers "Restart to update" when it is ready.
 */
import type { TfDesktopUpdateState } from "@triliumnext/commons";

export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface FeedSource {
    syncServerHost: string;
    deviceToken: string;
    build: number;
}

/** The Squirrel feed of a connected Mac, or `null` when there is nothing to ask. */
export function squirrelFeed({ syncServerHost, deviceToken, build }: FeedSource) {
    if (!syncServerHost || !deviceToken || build <= 0) {
        return null;
    }
    const origin = syncServerHost.replace(/\/+$/, "");
    return {
        url: `${origin}/__tf/desktop/squirrel?build=${build}`,
        headers: { "x-tf-device": deviceToken },
        serverType: "json" as const
    };
}

/** The part of Electron's `autoUpdater` this module uses, so tests can stand in for it. */
export interface AutoUpdaterLike {
    setFeedURL(options: { url: string; headers?: Record<string, string>; serverType?: "json" | "default" }): void;
    checkForUpdates(): void;
    quitAndInstall(): void;
    on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export class TfUpdater {
    private state: TfDesktopUpdateState = "off";
    private version: string | undefined;
    private feedKey = "";
    private timer: ReturnType<typeof setInterval> | null = null;

    constructor(
        private readonly updater: AutoUpdaterLike | null,
        private readonly getSource: () => FeedSource,
        private readonly onChange: () => void,
        private readonly log: (message: string) => void
    ) {
        if (!updater) {
            return;
        }
        updater.on("checking-for-update", () => this.set("checking"));
        updater.on("update-available", () => this.set("downloading"));
        updater.on("update-not-available", () => this.set("idle"));
        updater.on("update-downloaded", (_event, _notes, releaseName) => {
            this.version = typeof releaseName === "string" && releaseName ? releaseName : undefined;
            this.set("ready");
        });
        updater.on("error", (error) => {
            this.log(`Update check failed: ${error instanceof Error ? error.message : String(error)}`);
            if (this.state !== "ready") {
                this.set("idle");
            }
        });
    }

    getState() {
        return { state: this.state, version: this.version };
    }

    /** Starts the hourly checks (idempotent) and checks now. */
    start() {
        if (!this.updater) {
            return;
        }
        if (!this.timer) {
            this.timer = setInterval(() => this.check(), UPDATE_CHECK_INTERVAL_MS);
            this.timer.unref?.();
        }
        this.check();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.state !== "ready") {
            this.set("off");
        }
    }

    /** Checks now, with the feed of the current device key. A downloaded update is kept. */
    check() {
        if (!this.updater || this.state === "ready" || this.state === "downloading") {
            return;
        }
        const feed = squirrelFeed(this.getSource());
        if (!feed) {
            this.set("off");
            return;
        }
        try {
            const key = `${feed.url}\n${feed.headers["x-tf-device"]}`;
            if (key !== this.feedKey) {
                this.updater.setFeedURL(feed);
                this.feedKey = key;
            }
            if (this.state === "off") {
                this.set("idle");
            }
            this.updater.checkForUpdates();
        } catch (e) {
            this.log(`Update check could not start: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    restartToUpdate() {
        if (this.updater && this.state === "ready") {
            this.updater.quitAndInstall();
        }
    }

    private set(state: TfDesktopUpdateState) {
        if (this.state === state) {
            return;
        }
        this.state = state;
        this.onChange();
    }
}
