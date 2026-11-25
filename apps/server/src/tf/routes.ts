/**
 * `/api/tf/*` routes of an embedded engine. Registered only when `TF_EMBED=1`, so a plain build
 * answers 404 and the client knows it is not embedded.
 */
import { getTfProtectedState, getTfUser } from "@triliumnext/core/src/tf/index.js";

import { apiRoute } from "../routes/route_api.js";
import { getTfEngineVersion, getTfNotebookId, getTfParentOrigins, getUpstreamVersion, TF_SOURCE_URL } from "./env.js";
import { registerTfWorkRoutes } from "./work/routes.js";

export interface TfBootstrap {
    embed: true;
    notebookId: string;
    user: { id: string; name: string; role: "edit" | "view" } | null;
    parentOrigins: string[];
    engineVersion: string;
    upstreamVersion: string;
    sourceUrl: string;
}

export function registerTfRoutes() {
    apiRoute("get", "/api/tf/bootstrap", getBootstrap);
    apiRoute("get", "/api/tf/protected", () => getTfProtectedState());
    registerTfWorkRoutes();
}

export function getBootstrap(): TfBootstrap {
    const user = getTfUser();
    return {
        embed: true,
        notebookId: getTfNotebookId(),
        user: user ? { id: user.id, name: user.name, role: user.role } : null,
        parentOrigins: getTfParentOrigins(),
        engineVersion: getTfEngineVersion(),
        upstreamVersion: getUpstreamVersion(),
        sourceUrl: TF_SOURCE_URL
    };
}
