/**
 * The bridge between the notebook frame and the Taskforce page (protocol 1, see
 * `infra/notes/README.md` in Taskforce, "Bridge").
 *
 * Handshake: the frame posts `tf-notes:hello` to `window.parent` for each allowed parent origin
 * until the host answers with `tf-notes:port` and a `MessagePort`. All other messages go over that
 * port as `{ id?, method, params }`; a message with an `id` gets `{ id, result }` or
 * `{ id, error }` back.
 */

export const TF_BRIDGE_PROTOCOL = 1;

export interface BridgeError {
    code: string;
    message: string;
}

interface BridgeMessage {
    id?: string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: BridgeError;
}

type Handler = (params: any) => unknown;

interface Pending {
    resolve: (value: unknown) => void;
    reject: (error: BridgeError) => void;
}

export interface BridgeOptions {
    notebookId: string;
    parentOrigins: string[];
    /** The window the handshake targets; `window.parent` in the app. */
    parent?: Window;
    /** The window that receives the host's answer; `window` in the app. */
    self?: Window;
    /** Delay between hello attempts until the host answers. */
    helloIntervalMs?: number;
    /** Gives up after this many hello attempts. */
    maxHelloAttempts?: number;
}

const capabilities = new Set<string>([ "tf-bridge-1" ]);

/** Adds a capability to the list announced in `ready`. Call before the bridge connects. */
export function registerCapability(name: string) {
    capabilities.add(name);
}

export function getCapabilities() {
    return [ ...capabilities ];
}

export class TfBridge {
    private port: MessagePort | null = null;
    private readonly handlers = new Map<string, Handler>();
    private readonly pending = new Map<string, Pending>();
    private readonly queue: BridgeMessage[] = [];
    private nextId = 1;
    private helloTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly connectedPromise: Promise<void>;
    private resolveConnected!: () => void;
    private readonly parent: Window;
    private readonly self: Window;

    constructor(private readonly options: BridgeOptions) {
        this.parent = options.parent ?? window.parent;
        this.self = options.self ?? window;
        this.connectedPromise = new Promise((resolve) => {
            this.resolveConnected = resolve;
        });
    }

    /** Starts the handshake. Resolves once the host has handed over its port. */
    connect() {
        this.self.addEventListener("message", this.onWindowMessage);
        this.sayHello(1);
        return this.connectedPromise;
    }

    get connected() {
        return this.port !== null;
    }

    whenConnected() {
        return this.connectedPromise;
    }

    /** Registers the handler for a host → frame method. Its return value is the answer. */
    on(method: string, handler: Handler) {
        this.handlers.set(method, handler);
    }

    /** Sends a message that expects no answer. Queued until the port is open. */
    notify(method: string, params: unknown = {}) {
        this.send({ method, params });
    }

    /** Sends a request and resolves with the host's `result`, or rejects with its `error`. */
    request<T = unknown>(method: string, params: unknown = {}): Promise<T> {
        const id = `f${this.nextId++}`;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
            this.send({ id, method, params });
        });
    }

    dispose() {
        this.self.removeEventListener("message", this.onWindowMessage);
        if (this.helloTimer) {
            clearTimeout(this.helloTimer);
        }
        this.port?.close();
        this.port = null;
    }

    private sayHello(attempt: number) {
        if (this.port) {
            return;
        }

        const hello = { type: "tf-notes:hello", protocol: TF_BRIDGE_PROTOCOL, notebookId: this.options.notebookId };
        for (const origin of this.options.parentOrigins) {
            try {
                this.parent.postMessage(hello, origin);
            } catch {
                // The parent is on another origin; postMessage only delivers to the matching one.
            }
        }

        const maxAttempts = this.options.maxHelloAttempts ?? 40;
        if (attempt < maxAttempts) {
            const interval = this.options.helloIntervalMs ?? Math.min(250 * attempt, 2000);
            this.helloTimer = setTimeout(() => this.sayHello(attempt + 1), interval);
        }
    }

    private readonly onWindowMessage = (event: MessageEvent) => {
        if (this.port || !isAllowedOrigin(event.origin, this.options.parentOrigins)) {
            return;
        }
        if (event.source !== this.parent) {
            return;
        }
        const data = event.data as { type?: unknown } | null;
        const port = event.ports?.[0];
        if (!data || data.type !== "tf-notes:port" || !port) {
            return;
        }

        if (this.helloTimer) {
            clearTimeout(this.helloTimer);
            this.helloTimer = null;
        }
        this.self.removeEventListener("message", this.onWindowMessage);

        this.port = port;
        port.onmessage = (portEvent) => void this.onPortMessage(portEvent.data as BridgeMessage);
        port.start();

        for (const message of this.queue.splice(0)) {
            port.postMessage(message);
        }
        this.resolveConnected();
    };

    private async onPortMessage(message: BridgeMessage) {
        if (!message || typeof message !== "object") {
            return;
        }

        if (!message.method && message.id) {
            const pending = this.pending.get(message.id);
            if (pending) {
                this.pending.delete(message.id);
                if (message.error) {
                    pending.reject(message.error);
                } else {
                    pending.resolve(message.result);
                }
            }
            return;
        }

        if (!message.method) {
            return;
        }

        const handler = this.handlers.get(message.method);
        if (!handler) {
            if (message.id) {
                this.send({ id: message.id, error: { code: "unsupported", message: `Unknown method ${message.method}` } });
            }
            return;
        }

        try {
            const result = await handler(message.params ?? {});
            if (message.id) {
                this.send({ id: message.id, result: result ?? {} });
            }
        } catch (e) {
            if (message.id) {
                this.send({ id: message.id, error: { code: "failed", message: e instanceof Error ? e.message : String(e) } });
            }
        }
    }

    private send(message: BridgeMessage) {
        if (this.port) {
            this.port.postMessage(message);
        } else {
            this.queue.push(message);
        }
    }
}

export function isAllowedOrigin(origin: string, parentOrigins: string[]) {
    return !!origin && origin !== "null" && parentOrigins.includes(origin);
}

let bridge: TfBridge | null = null;

export function setTfBridge(value: TfBridge | null) {
    bridge = value;
}

/** The connected bridge of the running app, or `null` outside Taskforce. */
export function getTfBridge() {
    return bridge;
}
