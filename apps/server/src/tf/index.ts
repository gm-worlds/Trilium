/**
 * Server side of the Taskforce embedding. `installTf()` is the one call `app.ts` makes; it does
 * nothing unless `TF_EMBED=1`.
 */
import { initTfCore } from "@triliumnext/core/src/tf/index.js";
import type express from "express";

import { getTfEventsUrl, isTfEmbedEnv, isTfScriptsOff } from "./env.js";
import { TfEventSender } from "./events_sender.js";
import { tfGatewayGuard } from "./request_context.js";
import { registerTfRoutes } from "./routes.js";

let sender: TfEventSender | null = null;

export function installTf(app: express.Application) {
    if (!isTfEmbedEnv()) {
        return;
    }

    sender = new TfEventSender(getTfEventsUrl());
    const eventSender = sender;
    initTfCore({ eventSink: (event) => eventSender.push(event), scriptsOff: isTfScriptsOff() });

    app.use(tfGatewayGuard);
    registerTfRoutes();
}

export function getTfEventSender() {
    return sender;
}
