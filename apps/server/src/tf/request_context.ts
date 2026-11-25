/**
 * Gateway key check and request identity for an embedded engine.
 *
 * The gateway adds `x-tf-gateway-key` (equal to the engine's `TF_GATEWAY_KEY`) and the identity
 * headers to every request it forwards. {@link tfGatewayGuard} refuses anything without the key,
 * HTTP and WebSocket upgrade alike, so nothing on the loopback port is reachable around the
 * gateway. The identity it parses is copied into the execution context by
 * {@link applyTfRequestContext}, which `route_api.ts` calls for every route.
 */
import { becca_loader, cls } from "@triliumnext/core";
import { isTfReadOnlyError, parseTfIdentityHeaders, setTfRoute, setTfUser, type TfUser } from "@triliumnext/core/src/tf/index.js";
import { createHash, timingSafeEqual } from "crypto";
import type express from "express";
import type { IncomingMessage } from "http";

import { getTfGatewayKey } from "./env.js";

const HEALTH_CHECK_PATH = "/api/health-check";
const tfUsers = new WeakMap<IncomingMessage, TfUser | null>();

export function tfGatewayGuard(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (req.path === HEALTH_CHECK_PATH && isLoopback(req.socket.remoteAddress)) {
        next();
        return;
    }

    if (!hasValidGatewayKey(req)) {
        res.status(403).type("text/plain").send("Forbidden");
        return;
    }

    try {
        tfUsers.set(req, parseTfIdentityHeaders(req.headers));
    } catch (e) {
        res.status(400).type("text/plain").send(e instanceof Error ? e.message : "Bad request");
        return;
    }

    next();
}

/** Same check for a WebSocket upgrade, which never passes through the Express middleware. */
export function verifyTfUpgrade(req: IncomingMessage): boolean {
    if (!hasValidGatewayKey(req)) {
        return false;
    }

    try {
        tfUsers.set(req, parseTfIdentityHeaders(req.headers));
        return true;
    } catch {
        return false;
    }
}

/** The person the gateway named on this request (also for WebSocket upgrade requests). */
export function getTfRequestUser(req: IncomingMessage): TfUser | null {
    return tfUsers.get(req) ?? null;
}

/** Copies the request's identity and route pattern into the current execution context. */
export function applyTfRequestContext(req: IncomingMessage, routePath: string) {
    if (!tfUsers.has(req)) {
        return;
    }
    setTfUser(getTfRequestUser(req));
    setTfRoute(routePath);
}

/**
 * Answers a view-role write refusal as `403 { tfReadOnly: true }`; `false` for any other error.
 *
 * A handler can change an entity in becca before its `save()` is refused, and the rollback only
 * reloads becca when an entity change was recorded, so becca is loaded again here.
 */
export function sendTfError(e: unknown, res: express.Response): boolean {
    if (!isTfReadOnlyError(e)) {
        return false;
    }
    cls.init(() => becca_loader.load());
    if (!res.headersSent) {
        res.status(403).json({ tfReadOnly: true, message: e.message });
    }
    return true;
}

export function hasValidGatewayKey(req: IncomingMessage) {
    const expected = getTfGatewayKey();
    const header = req.headers["x-tf-gateway-key"];
    const given = Array.isArray(header) ? header[0] : header;

    if (!expected || !given) {
        return false;
    }

    // Comparing digests keeps the comparison constant-time even when the lengths differ.
    const a = createHash("sha256").update(given).digest();
    const b = createHash("sha256").update(expected).digest();
    return timingSafeEqual(a, b);
}

function isLoopback(address: string | undefined) {
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
