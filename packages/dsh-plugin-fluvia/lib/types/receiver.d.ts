/**
 * The HTTP receiver: the other end of fluvia's `--notify dsh:http://…`.
 *
 * Three routes and no framework. `POST <path>` takes an envelope, `GET <path>`
 * returns the same status as JSON, and `GET /` returns the human page. A
 * plugin lives inside somebody else's long-running process, so the two
 * properties that matter more than features are: the handler never throws
 * (an unhandled rejection in a harness process is a crash, not a 500), and the
 * port is always released on unload (a plugin that leaks a listener makes the
 * next reload fail with EADDRINUSE).
 *
 * @module dsh-plugin-fluvia/receiver
 */
import type { Courier, CourierLog, DeliveryMode, TargetSelector } from './courier.js';
/** Where and how to listen, plus who to hand envelopes to. */
export interface ReceiverOptions {
    /** Interface to bind; `127.0.0.1` keeps the endpoint off the network. */
    host: string;
    /** TCP port to bind. */
    port: number;
    /** Request path that accepts envelope POSTs, e.g. `/inbox`. */
    path: string;
    /** Delivery mode, reported on the status surfaces. */
    mode: DeliveryMode;
    /** Target selector, reported on the status surfaces. */
    target: TargetSelector;
    /** Queue bound, reported on the status surfaces. */
    queueLimit: number;
    /** The courier that routes accepted envelopes. */
    courier: Courier;
    /** Where the receiver reports bind and request problems. */
    log: CourierLog;
    /**
     * Whether `POST <path>` may deliver envelopes.
     *
     * False under `transport: 'connect'`, where results arrive on each session's
     * own socket. Accepting POSTs there would open a second, unauthenticated
     * path into an agent's turn — anything that could reach the port could put
     * text in front of the model — so the route answers 409 instead.
     */
    acceptPosts: boolean;
}
/** A bound receiver and the one thing its owner needs: a way to release the port. */
export interface Receiver {
    /** The port actually bound, which is the configured one unless `0` was asked for. */
    port: number;
    /** Close the listener and every open connection; resolves once the port is free. */
    close(): Promise<void>;
}
/**
 * Bind the receiver.
 *
 * Rejects when the port cannot be bound, which is the correct loud failure: a
 * plugin whose endpoint silently is not listening looks exactly like a plugin
 * that works, right up until the operator wonders where their notifications
 * went.
 *
 * @param options — bind address, route, and the courier to feed.
 * @returns the bound receiver.
 * @throws {Error} when `listen` fails (a taken port, a refused interface).
 */
export declare function startReceiver(options: ReceiverOptions): Promise<Receiver>;
//# sourceMappingURL=receiver.d.ts.map