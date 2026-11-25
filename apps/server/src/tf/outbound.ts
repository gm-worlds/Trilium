/**
 * The one way an embedded engine fetches an address that came from note content: images in pasted
 * or imported HTML, link previews and their oEmbed and thumbnail requests, the media proxy, and
 * any other caller of `safeFetch()` or `getImage()`.
 *
 * When embedded, `services/safe_fetch.ts` and `services/request.ts` hand every request here. A
 * request goes out only when:
 *
 * - the scheme is `http` or `https` and the port is the scheme's default;
 * - the host is not a single label and does not end in `.local`, `.internal`, `.lan`,
 *   `.home.arpa` or `.localhost`;
 * - every address the name resolves to is public unicast ({@link isTfPublicAddress});
 * - the connection goes to an address that was checked (the lookup is pinned).
 *
 * At most 3 redirects are followed, each checked the same way. A body over 20 MB or a request
 * over 15 s fails. A refusal is an ordinary error, so callers treat it like a failed download.
 */
import dns from "node:dns";
import net from "node:net";

import ipaddr from "ipaddr.js";
import type { Agent, RequestInit as UndiciRequestInit } from "undici";

export const TF_OUTBOUND_MAX_REDIRECTS = 3;
export const TF_OUTBOUND_MAX_BYTES = 20 * 1024 * 1024;
export const TF_OUTBOUND_TIMEOUT_MS = 15_000;

const LOCAL_SUFFIXES = [ ".local", ".internal", ".lan", ".home.arpa", ".localhost" ];

export class TfOutboundRefusedError extends Error {
    constructor(reason: string) {
        super(`Refused to fetch an address from note content: ${reason}.`);
        this.name = "TfOutboundRefusedError";
    }
}

export interface TfOutboundLimits {
    /** Redirects to follow, at most {@link TF_OUTBOUND_MAX_REDIRECTS}. */
    maxRedirects?: number;
}

/** What the guard resolves and accepts; replaced only by specs. */
export interface TfOutboundDeps {
    lookup(host: string): Promise<dns.LookupAddress[]>;
    isAllowedAddress(address: string): boolean;
    isAllowedPort(url: URL): boolean;
}

const defaultDeps: TfOutboundDeps = {
    lookup: async (host) => await dns.promises.lookup(host, { all: true, verbatim: true }),
    isAllowedAddress: isTfPublicAddress,
    isAllowedPort: (url) => url.port === ""
};

/**
 * Whether `address` (an IP literal, IPv6 with or without brackets) is public unicast. Refused:
 * loopback, private, link-local, unique-local, CGNAT, multicast, broadcast, unspecified, the
 * reserved and documentation ranges, and every IPv6 form that carries an IPv4 address
 * (IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo) unless it is an IPv4-mapped public address.
 */
export function isTfPublicAddress(address: string): boolean {
    const literal = address.replace(/^\[|\]$/g, "");
    if (!ipaddr.isValid(literal) || !net.isIP(literal)) {
        return false;
    }

    let parsed = ipaddr.parse(literal);
    if (parsed.kind() === "ipv6") {
        const v6 = parsed as ipaddr.IPv6;
        if (v6.isIPv4MappedAddress()) {
            parsed = v6.toIPv4Address();
        } else if (v6.parts.slice(0, 6).every((part) => part === 0)) {
            // `::`, `::1` and the deprecated IPv4-compatible `::a.b.c.d`.
            return false;
        }
    }
    return parsed.range() === "unicast";
}

/** The parsed URL when its scheme, port and host name may be fetched; throws {@link TfOutboundRefusedError} otherwise. */
export function checkTfOutboundUrl(rawUrl: string, deps: TfOutboundDeps = defaultDeps): URL {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new TfOutboundRefusedError("not a valid address");
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TfOutboundRefusedError(`the scheme ${url.protocol} is not allowed`);
    }
    if (!deps.isAllowedPort(url)) {
        throw new TfOutboundRefusedError("only the default port is allowed");
    }

    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(host)) {
        return url;
    }

    const name = host.toLowerCase().replace(/\.$/, "");
    if (!name.includes(".")) {
        throw new TfOutboundRefusedError("a host name without a domain is not allowed");
    }
    if (LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
        throw new TfOutboundRefusedError("a local host name is not allowed");
    }
    return url;
}

/** Resolves the host of `url` and checks every address. Returns the addresses to connect to. */
export async function resolveTfOutbound(url: URL, deps: TfOutboundDeps = defaultDeps): Promise<dns.LookupAddress[]> {
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const family = net.isIP(host);
    let addresses: dns.LookupAddress[];
    if (family) {
        addresses = [ { address: host, family } ];
    } else {
        try {
            addresses = await deps.lookup(host);
        } catch {
            throw new TfOutboundRefusedError("the host name does not resolve");
        }
    }

    if (addresses.length === 0 || addresses.some((entry) => !deps.isAllowedAddress(entry.address))) {
        throw new TfOutboundRefusedError("the address is not public");
    }
    return addresses;
}

/**
 * Fetches `rawUrl` under the rules above. The caller's `signal`, if any, is combined with the
 * 15 s deadline. The body of the answer stops with an error past 20 MB.
 */
export async function tfOutboundFetch(
    rawUrl: string, init: RequestInit = {}, limits: TfOutboundLimits = {}, deps: TfOutboundDeps = defaultDeps
): Promise<Response> {
    const maxRedirects = Math.min(limits.maxRedirects ?? TF_OUTBOUND_MAX_REDIRECTS, TF_OUTBOUND_MAX_REDIRECTS);
    const timeout = AbortSignal.timeout(TF_OUTBOUND_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([ init.signal, timeout ]) : timeout;

    // undici is CommonJS; a bundled ESM build exposes it only as `default` (see `safe_fetch.ts`).
    const undici = await import("undici");
    const { Agent: UndiciAgent, fetch: undiciFetch } = undici.default ?? undici;

    let currentUrl = rawUrl;
    for (let hop = 0; hop <= maxRedirects; hop++) {
        const url = checkTfOutboundUrl(currentUrl, deps);
        const addresses = await resolveTfOutbound(url, deps);
        const dispatcher: Agent = new UndiciAgent({ connect: { lookup: pinnedLookup(addresses) as never } });

        const response = await undiciFetch(url.toString(), {
            ...init,
            redirect: "manual",
            signal,
            dispatcher
        } as UndiciRequestInit);

        if (response.status >= 300 && response.status < 400) {
            void response.body?.cancel().catch(() => {});
            void dispatcher.close();
            const location = response.headers.get("location");
            if (!location) {
                throw new Error(`Redirect without a Location header from ${currentUrl}`);
            }
            if (hop === maxRedirects) {
                throw new TfOutboundRefusedError(`more than ${maxRedirects} redirects`);
            }
            currentUrl = new URL(location, url).toString();
            continue;
        }

        const length = Number(response.headers.get("content-length") ?? "");
        if (Number.isFinite(length) && length > TF_OUTBOUND_MAX_BYTES) {
            void response.body?.cancel().catch(() => {});
            void dispatcher.close();
            throw new TfOutboundRefusedError("the answer is larger than 20 MB");
        }

        return cappedResponse(response as unknown as Response, dispatcher);
    }

    throw new TfOutboundRefusedError("too many redirects");
}

/** `getImage()` for an embedded engine: the bytes of a 200, 201 or 204 answer, else an error. */
export async function tfOutboundGetImage(rawUrl: string, deps: TfOutboundDeps = defaultDeps): Promise<ArrayBuffer> {
    const response = await tfOutboundFetch(rawUrl, { method: "GET" }, {}, deps);
    if (![ 200, 201, 204 ].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        throw new Error(`Request to GET ${rawUrl} failed, error: ${response.status} ${response.statusText}`);
    }
    return await response.arrayBuffer();
}

function pinnedLookup(addresses: dns.LookupAddress[]) {
    return (_host: string, options: { family?: number; all?: boolean } | number, callback: (...args: unknown[]) => void) => {
        const opts = typeof options === "number" ? { family: options } : options;
        const matching = opts.family === 4 || opts.family === 6
            ? addresses.filter((entry) => entry.family === opts.family)
            : addresses;
        if (matching.length === 0) {
            callback(new Error("No checked address of the requested family"));
        } else if (opts.all) {
            callback(null, matching);
        } else {
            callback(null, matching[0].address, matching[0].family);
        }
    };
}

/** The same answer with a body that errors past {@link TF_OUTBOUND_MAX_BYTES} and closes the dispatcher when done. */
function cappedResponse(response: Response, dispatcher: Agent): Response {
    const init: ResponseInit = { status: response.status, statusText: response.statusText, headers: [ ...response.headers ] };
    const source = response.body;
    if (!source || [ 204, 205, 304 ].includes(response.status)) {
        void source?.cancel().catch(() => {});
        void dispatcher.close();
        return new Response(null, init);
    }

    const reader = source.getReader();
    let received = 0;
    let closed = false;
    const close = () => {
        if (!closed) {
            closed = true;
            void dispatcher.close();
        }
    };

    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    controller.close();
                    close();
                    return;
                }
                received += value.byteLength;
                if (received > TF_OUTBOUND_MAX_BYTES) {
                    void reader.cancel().catch(() => {});
                    controller.error(new TfOutboundRefusedError("the answer is larger than 20 MB"));
                    close();
                    return;
                }
                controller.enqueue(value);
            } catch (e) {
                controller.error(e);
                close();
            }
        },
        cancel() {
            void reader.cancel().catch(() => {});
            close();
        }
    });
    return new Response(body, init);
}
