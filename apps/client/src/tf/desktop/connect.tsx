/**
 * The connect screen of Taskforce Notes, shown in place of Trilium's setup wizard while this Mac
 * has no device key. It reads a connect link (pasted, or opened from Taskforce through the
 * `taskforce-notes:` scheme), offers to bring along a stock Trilium's notes when the link allows
 * it, and follows the first sync. The work happens in the main process (`apps/desktop/src/tf/`).
 */
import "../../setup.css";
import "./connect.css";

import type { ElectronTfDesktopApi, TfConnectCheck, TfDesktopInfo, TfReplaceProgress, TfStockTrilium } from "@triliumnext/commons";
import clsx from "clsx";
import i18next from "i18next";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

import { initLocale, t } from "../../services/i18n";
import { syncNativeWindowWithTheme } from "../../services/native_window";
import server from "../../services/server";
import { onEffectiveThemeStyleChange } from "../../services/theme";
import { formatSize } from "../../services/utils";
import Admonition from "../../widgets/react/Admonition";
import { Badge } from "../../widgets/react/Badge";
import Button from "../../widgets/react/Button";
import { Card, CardFrame, CardSection } from "../../widgets/react/Card";
import FormGroup from "../../widgets/react/FormGroup";
import FormTextBox from "../../widgets/react/FormTextBox";
import Icon from "../../widgets/react/Icon";
import ProgressBar from "../../widgets/react/ProgressBar";
import SetupPage from "../../widgets/react/SetupPage";
import { choiceProps } from "./choice";
import { getTfDesktopApi, tt } from "./state";

type Screen =
    | { kind: "link"; error?: string }
    | { kind: "checking" }
    | { kind: "version"; downloadUrl?: string; downloadVersion?: string }
    | { kind: "ready"; check: TfConnectCheck & { ok: true }; error?: string }
    | { kind: "bring"; check: TfConnectCheck & { ok: true }; stock: TfStockTrilium | null; error?: string }
    | { kind: "bringing"; progress: TfReplaceProgress | null }
    | { kind: "connecting" }
    | { kind: "other"; error?: string }
    | { kind: "replaced"; error?: string }
    | { kind: "syncing" };

async function main() {
    await initLocale("en", "entry");
    // Dutch is not one of Trilium's display languages; the `tfDesktop.*` strings carry it anyway.
    if (navigator.language?.toLowerCase().startsWith("nl")) {
        await i18next.changeLanguage("nl");
    }

    const wrapper = document.createElement("div");
    wrapper.classList.add("setup-outer-wrapper");
    // No `background-effects`: the page keeps the theme's opaque surface instead of showing the
    // window material through it, so text contrast never depends on what the material renders.
    document.body.classList.add("setup", "tf-desktop-connect", window.glob.device || "desktop", "electron", `platform-${window.glob.platform}`);
    render(<ConnectApp />, wrapper);
    document.body.replaceChildren(wrapper);
    // Follows the macOS appearance, live: the theme's light or dark stylesheet and the window chrome.
    syncNativeWindowWithTheme();
    onEffectiveThemeStyleChange(() => syncNativeWindowWithTheme());
}

export function ConnectApp() {
    const api = getTfDesktopApi();
    const [ info, setInfo ] = useState<TfDesktopInfo | null>(null);
    const [ link, setLink ] = useState("");
    const [ screen, setScreen ] = useState<Screen>({ kind: "link" });

    async function check(raw: string) {
        if (!api) {
            return;
        }
        setScreen({ kind: "checking" });
        const result = await api.checkLink(raw);
        setScreen(screenForCheck(result));
    }

    useEffect(() => {
        if (!api) {
            return;
        }
        void api.getInfo().then((current) => {
            setInfo(current);
            if (current.connected && !current.hasLocalNotes) {
                setScreen({ kind: "syncing" });
            } else if (current.pendingLink) {
                setLink(current.pendingLink);
                void check(current.pendingLink);
            }
        });
        const offLink = api.onLink((incoming) => {
            setLink(incoming);
            void check(incoming);
        });
        const offState = api.onState(setInfo);
        return () => {
            offLink();
            offState();
        };
    }, []);

    if (!api) {
        return null;
    }

    return (
        <div class="setup-container">
            <div class="drag-region" />
            <ConnectScreen
                api={api} info={info} screen={screen} setScreen={setScreen}
                link={link} setLink={setLink} check={check}
            />
        </div>
    );
}

function ConnectScreen({ api, info, screen, setScreen, link, setLink, check }: {
    api: ElectronTfDesktopApi;
    info: TfDesktopInfo | null;
    screen: Screen;
    setScreen: (screen: Screen) => void;
    link: string;
    setLink: (link: string) => void;
    check: (raw: string) => Promise<void>;
}) {
    async function connect(check: TfConnectCheck & { ok: true }) {
        setScreen({ kind: "connecting" });
        const result = await api.connect();
        if (result.ok) {
            if (check.mode === "new") {
                setScreen({ kind: "syncing" });
            }
            return;
        }
        if (result.message === "notebook_replaced") {
            setScreen({ kind: "replaced" });
            return;
        }
        setScreen({ kind: "ready", check, error: describeFailure(result.message) });
    }

    async function bring(check: TfConnectCheck & { ok: true }) {
        setScreen({ kind: "bringing", progress: null });
        const off = api.onReplaceProgress((progress) => setScreen({ kind: "bringing", progress }));
        try {
            const result = await api.bringStockNotes();
            if (!result.ok) {
                const stock = await api.checkStockTrilium();
                setScreen({ kind: "bring", check, stock, error: describeFailure(result.message, "bring_failed") });
                return;
            }
        } finally {
            off();
        }
        await connect(check);
    }

    async function startFresh(back: Screen) {
        const result = await api.startFresh();
        if (!result.ok) {
            setScreen({ ...back, error: tt("connect_failed") } as Screen);
        }
    }

    switch (screen.kind) {
        case "link":
        case "checking":
            return (
                <LinkScreen
                    api={api} info={info} link={link} setLink={setLink}
                    checking={screen.kind === "checking"}
                    error={screen.kind === "link" ? screen.error : undefined}
                    onContinue={() => void check(link)}
                />
            );
        case "version":
            return (
                <SetupPage
                    className="tf-version"
                    title={tt("version_title")}
                    description={tt("version_text")}
                    illustration={<Icon icon="bx bx-transfer-alt" className="illustration-icon" />}
                    onBack={() => setScreen({ kind: "link" })}
                    footer={screen.downloadUrl
                        ? <Button
                            kind="primary" icon="bx bx-download"
                            text={screen.downloadVersion ? tt("version_download", { version: screen.downloadVersion }) : tt("version_download_plain")}
                            onClick={() => screen.downloadUrl && window.electronApi?.shell.openExternal(screen.downloadUrl)}
                        />
                        : undefined}
                >
                    {!screen.downloadUrl && <Admonition type="note">{tt("version_none")}</Admonition>}
                </SetupPage>
            );
        case "ready":
            return (
                <SetupPage
                    className="tf-ready"
                    title={tt("ready_title")}
                    description={screen.check.mode === "reconnect" ? tt("reconnect_text") : tt("ready_text")}
                    illustration={<Illustration />}
                    error={screen.error}
                    onBack={() => setScreen({ kind: "link" })}
                    footer={<Button kind="primary" icon="bx bx-link" text={tt("button_connect")} onClick={() => void connect(screen.check)} />}
                >
                    <NotebookPill check={screen.check} />
                </SetupPage>
            );
        case "bring":
            return <BringScreen
                api={api} check={screen.check} stock={screen.stock} error={screen.error}
                onBack={() => setScreen({ kind: "link" })}
                onStock={(stock) => setScreen({ ...screen, stock, error: undefined })}
                onBring={() => void bring(screen.check)}
                onSkip={() => void connect(screen.check)}
            />;
        case "bringing":
            return <BringingScreen progress={screen.progress} />;
        case "connecting":
            return (
                <SetupPage className="tf-connecting" title={tt("button_connect")} illustration={<Illustration />}>
                    <Card><CardSection><Icon icon="bx bx-loader-circle bx-spin" /> {tt("checking")}</CardSection></Card>
                </SetupPage>
            );
        case "other":
        case "replaced": {
            const other = screen.kind === "other";
            const name = info?.notebookName;
            return (
                <SetupPage
                    className="tf-other"
                    title={other ? tt("other_title") : tt("replaced_title")}
                    description={other ? (name ? tt("other_text", { name }) : tt("other_text_unnamed")) : tt("replaced_text")}
                    illustration={<Icon icon="bx bx-archive-in" className="illustration-icon" />}
                    error={screen.error}
                    onBack={other ? () => setScreen({ kind: "link" }) : undefined}
                    footer={<Button kind="primary" icon="bx bx-refresh" text={tt("button_start_fresh")} onClick={() => void startFresh(screen)} />}
                />
            );
        }
        case "syncing":
            return <FirstSync />;
    }
}

function LinkScreen({ api, info, link, setLink, checking, error, onContinue }: {
    api: ElectronTfDesktopApi;
    info: TfDesktopInfo | null;
    link: string;
    setLink: (link: string) => void;
    checking: boolean;
    error?: string;
    onContinue: () => void;
}) {
    const revoked = info?.stop === "device_revoked" || info?.stop === "not_eligible";
    const disconnected = !!info?.hasLocalNotes;
    let title = tt("connect_title");
    let description = tt("connect_description");
    if (disconnected && revoked) {
        title = tt("revoked_title");
        description = tt("revoked_text");
    } else if (disconnected) {
        title = tt("disconnected_title");
        description = tt("disconnected_text");
    }

    return (
        <SetupPage
            className="tf-link top-aligned"
            title={title}
            description={description}
            illustration={<Illustration />}
            error={error}
            footer={<>
                {disconnected && <Button kind="lowProfile" icon="bx bx-book-open" text={tt("button_open_offline")} onClick={() => api.openNotesOffline()} />}
                <Button kind="primary" text={tt("button_continue")} disabled={checking || !link.trim()} onClick={onContinue} />
            </>}
        >
            <form onSubmit={(e) => { e.preventDefault(); onContinue(); }}>
                <Card>
                    <CardSection>
                        <FormGroup label={tt("link_label")} name="tfConnectLink" description={tt("link_hint")}>
                            <FormTextBox
                                placeholder={tt("link_placeholder")}
                                currentValue={link} onChange={setLink}
                                autoFocus spellcheck={false} autocomplete="off"
                            />
                        </FormGroup>
                    </CardSection>
                </Card>
            </form>
            {checking && (
                <p class="tf-checking" role="status">
                    <Icon icon="bx bx-loader-circle bx-spin" /> {tt("checking")}
                </p>
            )}
        </SetupPage>
    );
}

function BringScreen({ api, check, stock, error, onBack, onStock, onBring, onSkip }: {
    api: ElectronTfDesktopApi;
    check: TfConnectCheck & { ok: true };
    stock: TfStockTrilium | null;
    error?: string;
    onBack: () => void;
    onStock: (stock: TfStockTrilium | null) => void;
    onBring: () => void;
    onSkip: () => void;
}) {
    const found = !!stock?.found;
    const running = !!stock?.running;
    return (
        <SetupPage
            className="tf-bring"
            title={tt("bring_title")}
            description={tt("bring_text")}
            error={error}
            onBack={onBack}
        >
            <div class="setup-options">
                <CardFrame
                    className={clsx("setup-option-card", { disabled: !found || running })}
                    {...choiceProps(found && !running ? onBring : undefined)}
                    data-testid="tf-bring-option"
                >
                    <Icon icon="bx bx-import" />
                    <div>
                        <h3>{tt("bring_option")}</h3>
                        <p>{found ? tt("bring_option_size", { size: formatSize(stock?.sizeBytes ?? 0) }) : tt("bring_none")}</p>
                    </div>
                </CardFrame>
                <CardFrame className="setup-option-card" {...choiceProps(onSkip)} data-testid="tf-bring-skip">
                    <Icon icon="bx bx-link" />
                    <div>
                        <h3>{tt("bring_skip")}</h3>
                        <p>{tt("bring_skip_description")}</p>
                    </div>
                </CardFrame>
            </div>
            {found && running && (
                <Admonition type="caution" className="tf-trilium-running">
                    <p>{tt("bring_running")}</p>
                    <Button
                        kind="secondary" size="small" icon="bx bx-refresh" text={tt("button_check_again")}
                        onClick={() => void api.checkStockTrilium().then(onStock)}
                    />
                </Admonition>
            )}
            <NotebookPill check={check} />
        </SetupPage>
    );
}

function BringingScreen({ progress }: { progress: TfReplaceProgress | null }) {
    const phases: TfReplaceProgress["phase"][] = [ "copying", "sending", "importing" ];
    const current = progress ? phases.indexOf(progress.phase) : 0;
    return (
        <SetupPage className="tf-bringing sync-in-progress" title={tt("bring_title")} illustration={<Illustration />}>
            <Card className="sync-steps">
                {phases.map((phase, i) => (
                    <CardSection className={i < current ? "completed" : i === current ? "active" : ""} key={phase}>
                        <Icon icon={i < current ? "bx bx-check-circle" : i === current ? "bx bx-loader-circle bx-spin" : "bx bx-circle"} />{" "}
                        {tt(phase)}
                        {i === current && phase !== "importing" && progress && progress.total > 0 && (
                            <div class="sync-progress">
                                <ProgressBar value={progress.done} max={progress.total} />
                                <span>{Math.min(100, Math.round((progress.done / progress.total) * 100))}%</span>
                            </div>
                        )}
                    </CardSection>
                ))}
            </Card>
        </SetupPage>
    );
}

interface SyncStats {
    outstandingPullCount: number;
    totalPullCount: number | null;
    initialized: boolean;
    lastSyncError?: string | null;
}

/** The first sync, as the setup wizard's own progress screen shows it. */
function FirstSync() {
    const [ stats, setStats ] = useState<SyncStats>({ outstandingPullCount: 0, totalPullCount: null, initialized: false });

    useEffect(() => {
        const refresh = async () => {
            try {
                const next = await server.get<SyncStats>("sync/stats");
                // The main process swaps this window for the notes once the database is initialized
                // and loaded (`openNotesAfterFirstSync`).
                setStats(next);
            } catch {
                // The next poll tries again.
            }
        };
        const interval = setInterval(refresh, 1000);
        void refresh();
        return () => clearInterval(interval);
    }, []);

    const pulled = stats.totalPullCount ? Math.max(0, stats.totalPullCount - stats.outstandingPullCount) : 0;
    const step = stats.initialized ? 3 : stats.totalPullCount === null ? 0 : stats.outstandingPullCount > 0 ? 1 : 2;
    const steps = [ t("setup.sync-step-connecting"), t("setup.sync-step-syncing"), t("setup.sync-step-finalizing") ];

    return (
        <SetupPage
            className="sync-in-progress tf-first-sync"
            title={tt("syncing_title")}
            illustration={<Illustration />}
            footer={stats.lastSyncError
                ? <Button kind="primary" icon="bx bx-refresh" text={tt("button_retry")} onClick={() => void server.post("sync/now").catch(() => {})} />
                : undefined}
        >
            <Card className="sync-steps">
                {steps.map((label, i) => (
                    <CardSection className={i < step ? "completed" : i === step ? "active" : ""} key={label}>
                        <Icon icon={i < step ? "bx bx-check-circle" : i === step ? "bx bx-loader-circle bx-spin" : "bx bx-circle"} />{" "}
                        {label}
                        {i === 1 && (
                            <div class="sync-progress">
                                <ProgressBar value={step > 1 ? 1 : pulled} max={step > 1 ? 1 : (stats.totalPullCount ?? 1)} />
                                <span>{step > 1 ? 100 : stats.totalPullCount ? Math.min(100, Math.round((pulled / stats.totalPullCount) * 100)) : 0}%</span>
                            </div>
                        )}
                    </CardSection>
                ))}
            </Card>
            {stats.lastSyncError && (
                <Admonition type="caution" className="tf-sync-error">
                    {tt("sync_failed")}
                </Admonition>
            )}
        </SetupPage>
    );
}

function Illustration() {
    return (
        <div class="sync-illustration">
            <div>
                <Icon icon="bx bx-laptop" />
                {t("setup.sync-illustration-this-device")}
            </div>
            <div class="sync-illustration-arrows" />
            <div>
                <Icon icon="bx bx-book-content" />
                {tt("settings_title")}
            </div>
        </div>
    );
}

export function screenForCheck(result: TfConnectCheck): Screen {
    if (!result.ok) {
        switch (result.reason) {
            case "version_mismatch":
                return { kind: "version", downloadUrl: result.downloadUrl, downloadVersion: result.downloadVersion };
            case "bad_link":
                return { kind: "link", error: tt("bad_link") };
            case "code_refused":
                return { kind: "link", error: tt("code_refused") };
            case "not_eligible":
                return { kind: "link", error: tt("not_eligible_link") };
            case "network":
                return { kind: "link", error: tt("network") };
            default:
                return { kind: "link", error: tt("server_error") };
        }
    }
    if (result.mode === "other_notebook") {
        return { kind: "other" };
    }
    if (result.replaceAllowed) {
        return { kind: "bring", check: result, stock: result.stockTrilium };
    }
    return { kind: "ready", check: result };
}

/**
 * A readable sentence for the main process's failure codes. Anything else (a raw error, which can
 * hold an address or a file path) is not shown; the main process has logged it.
 */
export function describeFailure(message: string, fallback: "connect_failed" | "bring_failed" = "connect_failed") {
    switch (message) {
        case "code_refused": return tt("code_refused");
        case "not_eligible": return tt("not_eligible_link");
        case "network": return tt("network");
        case "server": return tt("server_error");
        case "version_mismatch": return tt("version_text");
        case "stock_trilium_running": return tt("bring_running");
        case "no_stock_trilium": return tt("bring_none");
        default: return tt(fallback);
    }
}

/** The notebook this link connects to, as a labelled pill: "Notebook  [icon] Name, Person". */
function NotebookPill({ check }: { check: TfConnectCheck & { ok: true } }) {
    const name = check.notebookName?.trim();
    if (!name) {
        return null;
    }
    const person = check.userName?.trim();
    return (
        <div class="tf-notebook-line">
            <span class="tf-notebook-label">{tt("pill_label")}</span>
            <Badge className="tf-notebook-pill" icon="bx bx-book-content" text={person ? tt("pill_text", { name, person }) : name} />
        </div>
    );
}

export const ready = import.meta.env.MODE !== "test" ? main() : Promise.resolve();
