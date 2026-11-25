/**
 * `/api/tf/*` routes of the work features: the to-do roll-up, ticking a to-do from it, and the
 * Word export. Registered by `registerTfRoutes()`, so only when `TF_EMBED=1`.
 */
import { randomBytes } from "node:crypto";

import {
    collectTfDocxSource, listTfTodos, resolveTfDocxImage, safeDocxFileName, toggleTfTodo
} from "@triliumnext/core/src/tf/work/index.js";
import { getTfUser } from "@triliumnext/core/src/tf/index.js";
import { NotFoundError, utils as coreUtils } from "@triliumnext/core";
import type express from "express";

import { doubleCsrfProtection as csrfMiddleware } from "../../routes/csrf_protection.js";
import { apiResultHandler, apiRoute, asyncRoute } from "../../routes/route_api.js";
import auth from "../../services/auth.js";
import { getTfParentOrigins } from "../env.js";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** How long a prepared Word file waits for its download. */
const PREPARED_TTL_MS = 60_000;

interface PreparedDocx {
    bytes: Uint8Array;
    fileName: string;
    userId: string | null;
    timer: ReturnType<typeof setTimeout>;
}

const prepared = new Map<string, PreparedDocx>();

export function registerTfWorkRoutes() {
    apiRoute("get", "/api/tf/todos", (req) => listTfTodos(req.query as Record<string, string>));
    apiRoute("post", "/api/tf/todos/toggle", (req) => toggleTfTodo(req.body ?? {}));
    // `file/:token` before `:noteId`, which would otherwise take "file" for a note id.
    asyncRoute("get", "/api/tf/export/docx/file/:token", [ auth.checkApiAuthOrElectron ], downloadPreparedDocx);
    asyncRoute("post", "/api/tf/export/docx/:noteId", [ auth.checkApiAuthOrElectron, csrfMiddleware ], prepareDocx, apiResultHandler);
    asyncRoute("get", "/api/tf/export/docx/:noteId", [ auth.checkApiAuthOrElectron ], exportDocx);
}

/**
 * Builds the file and keeps it for {@link PREPARED_TTL_MS} under a one-time token. The client then
 * downloads it by navigating to `file/:token`, the way upstream exports download, which a frame
 * embedded in Taskforce may do where an `<a download>` of a blob does not start.
 */
async function prepareDocx(req: express.Request<{ noteId: string }>) {
    const { bytes, fileName } = await buildDocx(req.params.noteId, isWithChildren(req));
    const token = randomBytes(18).toString("base64url");
    const timer = setTimeout(() => prepared.delete(token), PREPARED_TTL_MS);
    timer.unref?.();
    prepared.set(token, { bytes, fileName, userId: getTfUser()?.id ?? null, timer });
    return { token, fileName };
}

async function downloadPreparedDocx(req: express.Request<{ token: string }>, res: express.Response) {
    const file = prepared.get(req.params.token);
    if (!file || file.userId !== (getTfUser()?.id ?? null)) {
        throw new NotFoundError("This Word file is no longer available.");
    }
    prepared.delete(req.params.token);
    clearTimeout(file.timer);
    sendDocx(res, file.bytes, file.fileName);
}

async function exportDocx(req: express.Request<{ noteId: string }>, res: express.Response) {
    const { bytes, fileName } = await buildDocx(req.params.noteId, isWithChildren(req));
    sendDocx(res, bytes, fileName);
}

async function buildDocx(noteId: string, withChildren: boolean) {
    const source = collectTfDocxSource(noteId, withChildren);
    // The `docx` library loads on the first export only, in a chunk of its own.
    const { buildTfDocx } = await import("./docx.js");
    const bytes = await buildTfDocx(source, {
        resolveImage: resolveTfDocxImage,
        linkBase: getTfParentOrigins()[0]
    });
    return { bytes, fileName: safeDocxFileName(source.title) };
}

function isWithChildren(req: express.Request) {
    return req.query.children === "1" || req.query.children === "true";
}

function sendDocx(res: express.Response, bytes: Uint8Array, fileName: string) {
    res.setHeader("Content-Disposition", coreUtils.getContentDisposition(fileName));
    res.setHeader("Content-Type", DOCX_MIME);
    res.send(Buffer.from(bytes));
}
