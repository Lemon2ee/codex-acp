import type {CodexAcpClient} from "./CodexAcpClient";
import type {AuthStatus} from "./AuthStatusMeta";
import type {ServerNotification} from "./app-server";
import type {GetAccountRateLimitsResponse} from "./app-server/v2";
import {logger} from "./Logger";
import {
    createRateLimitsMap,
    mergeRateLimitSnapshot,
    rateLimitWindowLabel,
    type RateLimitsMap,
} from "./RateLimitsMap";

/**
 * `rateLimits` — interim `_meta`-based ACP extension that reports how much of
 * its plan's usage limits the agent's own login has used, as data: the windows
 * `/status` shows, such as the 5-hour and the weekly window of a ChatGPT plan.
 * A client can then show them before the first prompt of a session.
 *
 * Push only, connection-scoped like `authStatus`: the notification
 * `_auth/rate_limits_update` with `{rateLimits}`. The client sends nothing.
 * The empty capability marker `rateLimits` sits next to `authStatus`.
 *
 * The agent pushes:
 * - after each change of the auth status to a ChatGPT login, from an
 *   `account/rateLimits/read`. The first auth status of the connection is
 *   such a change;
 * - on each app-server `account/rateLimits/updated`, which Codex sends while
 *   turns run, merged into the last read the way `/status` merges it;
 * - `windows: []` when the login has no plan limits: an API key, Bedrock, or
 *   a gateway. While nobody is logged in it pushes nothing, except the empty
 *   list that clears windows it pushed for a login that is gone.
 *
 * It pushes only when the payload changed. A read that fails pushes nothing.
 *
 * The payload moves to first-class protocol fields once an upstream RFD for
 * rate limits lands; this extension is retired then.
 */
export const RATE_LIMITS_UPDATE_METHOD = "_auth/rate_limits_update";
export const RATE_LIMITS_META_KEY = "rateLimits";

export interface RateLimitWindow {
    /** Stable for the same window across updates, and unique in the list: `codex:primary`. */
    id: string;
    /** Human-readable, agent-defined: "Codex 5h limit". */
    label: string;
    /** Share of the window used, 0–100. */
    usedPercent: number;
    /** When the window resets, as an ISO 8601 date-time. Absent when unknown. */
    resetsAt?: string;
    /** Length of the window in minutes: 300, 10080. Absent when unknown. */
    windowMinutes?: number;
    /**
     * Set when only some models count against the window: the plan's name for
     * them, the `limitName` of a bucket that Codex ties to a model. It is not a
     * model id.
     */
    model?: string;
}

export interface RateLimits {
    /** Every window that applies to the login, in the order `/status` shows them. Empty when the login has no plan limits. */
    windows: RateLimitWindow[];
}

/** Params of the `_auth/rate_limits_update` notification. */
export type RateLimitsUpdateNotification = {
    rateLimits: RateLimits;
}

/**
 * Capability advertised in the `initialize` response next to `authStatus`: an
 * empty object whose presence means "this agent pushes its rate limits".
 */
export type RateLimitsCapability = {}

export function rateLimitsCapability(): RateLimitsCapability {
    return {};
}

/** The windows of every bucket, primary before secondary. */
export function fromRateLimitsMap(rateLimits: RateLimitsMap): RateLimits {
    const windows: RateLimitWindow[] = [];
    for (const entry of rateLimits.values()) {
        const slots = [["primary", entry.snapshot.primary], ["secondary", entry.snapshot.secondary]] as const;
        for (const [slot, window] of slots) {
            if (!window) continue;
            windows.push({
                id: `${entry.limitId}:${slot}`,
                label: `${entry.limitName} ${rateLimitWindowLabel(window.windowDurationMins)}`,
                usedPercent: window.usedPercent,
                ...(window.resetsAt !== null ? {resetsAt: new Date(window.resetsAt * 1000).toISOString()} : {}),
                ...(window.windowDurationMins !== null ? {windowMinutes: window.windowDurationMins} : {}),
                ...(entry.snapshot.normalModelSlug !== null ? {model: entry.limitName} : {}),
            });
        }
    }
    return {windows};
}

/** Do two payloads carry the same values? `previous` null means nothing was pushed yet. */
export function sameRateLimits(previous: RateLimits | null, next: RateLimits): boolean {
    return previous !== null && JSON.stringify(previous) === JSON.stringify(next);
}

export interface RateLimitsHost {
    /** The client of the app-server that runs now. */
    client(): CodexAcpClient;
    /** `account/rateLimits/read` on {@link client}, with the agent's process check. */
    readRateLimits(): Promise<GetAccountRateLimitsResponse>;
    notify(params: RateLimitsUpdateNotification): Promise<void>;
}

/** Keeps the connection's rate limits and pushes `_auth/rate_limits_update`. */
export class RateLimitsReporter {
    private snapshots: RateLimitsMap | null = null;
    private current: RateLimits | null = null;
    /** Counts the `account/rateLimits/updated` merged so far, so a read that an update overtook is dropped. */
    private updates = 0;
    private readonly observedClients = new WeakSet<CodexAcpClient>();

    constructor(private readonly host: RateLimitsHost) {}

    /** The last payload pushed. */
    get rateLimits(): RateLimits | null {
        return this.current;
    }

    /**
     * Follows the `account/rateLimits/updated` of `client`'s app-server. The
     * notification carries no thread, and arrives also while no session exists.
     * Only the client that runs now counts: a crashed one that still reports is ignored.
     */
    observe(client: CodexAcpClient): void {
        if (this.observedClients.has(client)) return;
        this.observedClients.add(client);
        client.appServerClient.onClientTransportEvent((event) => {
            if (event.eventType !== "notification" || this.host.client() !== client) return;
            const notification = event as unknown as ServerNotification;
            if (notification.method !== "account/rateLimits/updated") return;
            this.updates += 1;
            const update = notification.params.rateLimits;
            const limitId = update.limitId ?? "codex";
            const snapshots: RateLimitsMap = new Map(this.snapshots ?? []);
            const previous = snapshots.get(limitId);
            const snapshot = previous ? mergeRateLimitSnapshot(previous.snapshot, update) : {...update, limitId};
            snapshots.set(limitId, {
                limitId,
                limitName: snapshot.limitName ?? previous?.limitName ?? limitId,
                snapshot,
            });
            this.snapshots = snapshots;
            void this.publish(fromRateLimitsMap(snapshots));
        });
    }

    /** Reads the limits again when the login is a ChatGPT account, and reports none for a login without a plan. */
    authStatusChanged(authStatus: AuthStatus): void {
        switch (authStatus.kind) {
            case "account":
                void this.read();
                return;
            case "api_key":
            case "external":
            case "gateway":
                this.snapshots = null;
                void this.publish({windows: []});
                return;
            case "none":
                this.snapshots = null;
                if (this.current !== null) void this.publish({windows: []});
                return;
        }
    }

    private async read(): Promise<void> {
        const updatesBefore = this.updates;
        let response: GetAccountRateLimitsResponse;
        try {
            response = await this.host.readRateLimits();
        } catch (error) {
            logger.log("Failed to read rate limits", {error: String(error)});
            return;
        }
        if (this.updates !== updatesBefore) return;
        try {
            this.snapshots = createRateLimitsMap(response);
        } catch (error) {
            logger.log("Ignoring an unreadable rate limits response", {error: String(error)});
            return;
        }
        await this.publish(fromRateLimitsMap(this.snapshots));
    }

    private async publish(next: RateLimits): Promise<void> {
        if (sameRateLimits(this.current, next)) return;
        this.current = next;
        try {
            await this.host.notify({rateLimits: next});
        } catch (error) {
            logger.log("Failed to send rate limits update", {error: String(error)});
        }
    }
}
