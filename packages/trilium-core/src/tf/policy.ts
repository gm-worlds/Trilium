/**
 * What an embedded engine refuses to do, whoever asks: options that would send the notebook or
 * requests from the server network elsewhere, sync, AI providers, the SQL console.
 *
 * The gateway in front blocks the matching routes too, but the engine does not rely on it.
 */
import { ForbiddenError } from "../errors.js";
import { isTfEmbedded, isTfScriptsOff } from "./identity.js";

/**
 * Option names nobody writes through the options API when embedded, by prefix.
 *
 * | Prefix | Why |
 * |---|---|
 * | `sync` | `syncServerHost`, `syncProxy` and the timeouts make the engine push and pull the whole notebook |
 * | `llm`, `ai`, `mcp`, `openai`, `anthropic`, `ollama`, `voyage` | AI providers and their base URLs and keys (`llmProviders`, `llmWebSearchProvider`, `llmPermissionMode`, `aiEnabled`, `aiAssistantModel`, `mcpEnabled`, `openaiApiKey`, `anthropicApiKey`) |
 * | `transcription`, `transcript` | meeting transcription downloads and runs models on the server |
 * | `backup`, `dailyBackup`, `weeklyBackup`, `monthlyBackup` | backups belong to the host; `customDbBackupDir` is listed by name |
 */
export const TF_REFUSED_OPTION_PREFIXES: readonly string[] = [
    "sync",
    "llm",
    "ai",
    "mcp",
    "openai",
    "anthropic",
    "ollama",
    "voyage",
    "transcription",
    "transcript",
    "backup",
    "dailyBackup",
    "weeklyBackup",
    "monthlyBackup"
];

/**
 * Option names refused by name.
 *
 * | Option | Why |
 * |---|---|
 * | `allowedHtmlTags` | widens what the sanitizer lets into every person's notes (stored script) |
 * | `customDbBackupDir` | makes the engine write the database to any directory on the server |
 * | `mfaMethod` | sign-in belongs to Taskforce |
 * | `checkForUpdates` | the client would call GitHub; the host ships updates |
 * | `redirectBareDomain` | sends `/` to the share page, which takes the notebook away from everyone |
 * | `showLoginInShareTheme` | a sign-in link on share pages, which the gateway serves |
 *
 * Kept writable on purpose: `customSearchEngineUrl` (a link opened in the person's own browser),
 * `downloadImagesAutomatically` and the link preview options (content features, requests go to
 * the addresses notes already contain).
 */
export const TF_REFUSED_OPTIONS: ReadonlySet<string> = new Set([
    "allowedHtmlTags",
    "customDbBackupDir",
    "mfaMethod",
    "checkForUpdates",
    "redirectBareDomain",
    "showLoginInShareTheme"
]);

export class TfRefusedOptionError extends ForbiddenError {
    constructor(name: string) {
        super(`The option '${name}' is managed by Taskforce.`);
        this.name = "TfRefusedOptionError";
    }
}

/** Whether writes to the option `name` are refused; always `false` outside embed mode. */
export function isTfRefusedOption(name: string) {
    if (!isTfEmbedded()) {
        return false;
    }
    return TF_REFUSED_OPTIONS.has(name) || TF_REFUSED_OPTION_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Throws {@link TfRefusedOptionError} for a refused option. */
export function assertTfOptionWritable(name: string) {
    if (isTfRefusedOption(name)) {
        throw new TfRefusedOptionError(name);
    }
}

/**
 * Overrides for the `GET /api/options` answer when embedded: AI, MCP, sync, the SQL console and
 * update checks read as off, scripting as off with `TF_SCRIPTS=off`, and the provider list (which
 * holds API keys) and server paths as empty.
 */
export function tfReportedOptions(): Record<string, string> {
    if (!isTfEmbedded()) {
        return {};
    }

    return {
        aiEnabled: "false",
        mcpEnabled: "false",
        llmProviders: "[]",
        llmWebSearchProvider: "",
        transcriptionEnabled: "false",
        sqlConsoleEnabled: "false",
        checkForUpdates: "false",
        syncServerHost: "",
        syncProxy: "",
        effectiveSyncServerHost: "",
        customDbBackupDir: "",
        ...(isTfScriptsOff() ? { backendScriptingEnabled: "false" } : {})
    };
}

/** Whether sync with a sync server is off: always when embedded, whatever the options say. */
export function isTfSyncOff() {
    return isTfEmbedded();
}

/** Throws when an AI provider would be created: an embedded engine sends nothing to one. */
export function assertTfAiAllowed() {
    if (isTfEmbedded()) {
        throw new ForbiddenError("AI is off in this notebook.");
    }
}

/** Whether `#appCss` notes and user-made themes are left out: when embedded with scripts off. */
export function isTfCustomCssOff() {
    return isTfScriptsOff();
}

const BUILT_IN_THEMES: ReadonlySet<string> = new Set([ "auto", "light", "dark", "next", "next-light", "next-dark" ]);

/** The theme the page bootstrap names: a user-made theme becomes `next` while {@link isTfCustomCssOff}. */
export function tfBootstrapTheme(theme: string) {
    return isTfCustomCssOff() && !BUILT_IN_THEMES.has(theme) ? "next" : theme;
}

const RAW_SHARE_SANDBOX = "sandbox; default-src 'none'";

/**
 * Headers for raw share content (`#shareRaw`, `?raw`) and `/share/api/notes/:noteId/view` when
 * embedded: a sandbox without any source, no sniffing, and a download for HTML, SVG and XML.
 * An empty object outside embed mode.
 */
export function tfRawShareHeaders(mime: string): Record<string, string> {
    if (!isTfEmbedded()) {
        return {};
    }

    const headers: Record<string, string> = {
        "Content-Security-Policy": RAW_SHARE_SANDBOX,
        "X-Content-Type-Options": "nosniff"
    };
    if (isActiveMarkupMime(mime)) {
        headers["Content-Disposition"] = "attachment";
    }
    return headers;
}

function isActiveMarkupMime(mime: string) {
    const type = mime.split(";")[0].trim().toLowerCase();
    return type === "text/html"
        || type === "application/xhtml+xml"
        || type === "image/svg+xml"
        || type === "text/xml"
        || type === "application/xml"
        || type.endsWith("+xml");
}
