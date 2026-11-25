/**
 * Core side of the Taskforce embedding (`TF_EMBED=1`). The host enables it with
 * {@link initTfCore}; until then every hook in upstream code is a no-op.
 */
import { enableTfEmbed } from "./identity.js";
import { setTfEventSink, subscribeTfEvents, type TfEventSink } from "./events.js";

export * from "./identity.js";
export * from "./options.js";
export * from "./guard.js";
export * from "./save_guard.js";
export * from "./events.js";
export * from "./protected.js";

export function initTfCore(opts: { eventSink?: TfEventSink | null } = {}) {
    enableTfEmbed(true);
    setTfEventSink(opts.eventSink ?? null);
    subscribeTfEvents();
}
