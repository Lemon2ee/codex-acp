import type {GetAccountRateLimitsResponse, RateLimitSnapshot} from "./app-server/v2";

export type RateLimitEntry = {
    limitId: string;
    limitName: string;
    snapshot: RateLimitSnapshot;
};

export type RateLimitsMap = Map<string, RateLimitEntry>;

function rateLimitId(snapshot: RateLimitSnapshot, fallback = "codex"): string {
    return snapshot.limitId ?? fallback;
}

export function createRateLimitsMap(response: GetAccountRateLimitsResponse): RateLimitsMap {
    const result: RateLimitsMap = new Map();
    const snapshots = Object.entries(response.rateLimitsByLimitId ?? {})
        .filter((entry): entry is [string, RateLimitSnapshot] => entry[1] !== undefined);

    if (snapshots.length === 0) {
        snapshots.push([rateLimitId(response.rateLimits), response.rateLimits]);
    }

    for (const [fallbackId, snapshot] of snapshots) {
        const limitId = rateLimitId(snapshot, fallbackId);
        result.set(limitId, {
            limitId,
            limitName: snapshot.limitName ?? limitId,
            snapshot,
        });
    }
    return result;
}

export function mergeRateLimitSnapshot(
    previous: RateLimitSnapshot,
    update: RateLimitSnapshot,
): RateLimitSnapshot {
    return {
        ...update,
        limitId: update.limitId ?? "codex",
        credits: update.credits ?? previous.credits,
        individualLimit: update.individualLimit ?? previous.individualLimit,
        spendControlReached: update.spendControlReached ?? previous.spendControlReached,
        planType: update.planType ?? previous.planType,
    };
}

/** The name of a rate-limit window by its length: "5h limit", "Weekly limit". */
export function rateLimitWindowLabel(windowDurationMins: number | null): string {
    if (windowDurationMins === null) {
        return "Limit";
    }
    if (windowDurationMins < 60) {
        return `${windowDurationMins}m limit`;
    }
    if (windowDurationMins < 1440) {
        const hours = Math.round(windowDurationMins / 60);
        return `${hours}h limit`;
    }
    if (windowDurationMins < 10080) {
        const days = Math.round(windowDurationMins / 1440);
        return `${days}d limit`;
    }
    return "Weekly limit";
}
