import {describe, expect, it, vi} from "vitest";
import * as acp from "@agentclientprotocol/sdk/unstable";
import {PROTOCOL_VERSION} from "@agentclientprotocol/sdk/unstable";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {z} from "zod";
import {createAcpAgentRouter} from "../../AcpAgentRouter";
import {CodexAcpClient} from "../../CodexAcpClient";
import {CodexAcpServer} from "../../CodexAcpServer";
import {CodexAppServerClient} from "../../CodexAppServerClient";
import {createMockConnections} from "./test-utils";
import {
    awaitFirstAuthStatusPush,
    createCodexMockTestFixture,
    type CodexMockTestFixture,
    type MethodCallEvent,
} from "../acp-test-utils";
import {RATE_LIMITS_UPDATE_METHOD, type RateLimits} from "../../RateLimitsMeta";
import type {Account, GetAccountRateLimitsResponse, RateLimitSnapshot} from "../../app-server/v2";

/** 2026-10-22T15:40:00Z and 2026-10-26T09:00:00Z, in the seconds Codex sends. */
const FIVE_HOUR_RESET = 1792683600;
const WEEKLY_RESET = 1793005200;

const CODEX_SNAPSHOT: RateLimitSnapshot = {
    limitId: "codex",
    limitName: "Codex",
    normalModelSlug: null,
    primary: {usedPercent: 38, windowDurationMins: 300, resetsAt: FIVE_HOUR_RESET},
    secondary: {usedPercent: 59, windowDurationMins: 10080, resetsAt: WEEKLY_RESET},
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "plus",
    rateLimitReachedType: null,
};

function rateLimitsResponse(...snapshots: RateLimitSnapshot[]): GetAccountRateLimitsResponse {
    return {
        ordinaryUsageAllowed: true,
        rateLimits: snapshots[0]!,
        rateLimitsByLimitId: Object.fromEntries(snapshots.map(snapshot => [snapshot.limitId, snapshot])),
        rateLimitResetCredits: null,
        accountId: null,
        rateLimitUpsell: null,
    };
}

const CODEX_WINDOWS: RateLimits = {
    windows: [
        {
            id: "codex:primary",
            label: "Codex 5h limit",
            usedPercent: 38,
            resetsAt: "2026-10-22T15:40:00.000Z",
            windowMinutes: 300,
        },
        {
            id: "codex:secondary",
            label: "Codex Weekly limit",
            usedPercent: 59,
            resetsAt: "2026-10-26T09:00:00.000Z",
            windowMinutes: 10080,
        },
    ],
};

const CHAT_GPT: Account = {type: "chatgpt", email: "user@example.com", planType: "plus"};

function rateLimitsUpdates(fixture: CodexMockTestFixture): RateLimits[] {
    return fixture.getAcpConnectionEvents([])
        .filter((event: MethodCallEvent) => event.method === "notify" && event.args[0] === RATE_LIMITS_UPDATE_METHOD)
        .map((event: MethodCallEvent) => (event.args[1] as {rateLimits: RateLimits}).rateLimits);
}

async function awaitRateLimitsUpdates(fixture: CodexMockTestFixture, count: number): Promise<RateLimits[]> {
    await vi.waitFor(() => expect(rateLimitsUpdates(fixture)).toHaveLength(count));
    return rateLimitsUpdates(fixture);
}

function mockAccount(fixture: CodexMockTestFixture, account: Account | null) {
    vi.spyOn(fixture.getCodexAcpClient(), "getAccount").mockResolvedValue({
        account,
        requiresOpenaiAuth: account === null,
    });
}

/** Lets every already-scheduled callback run, so that "nothing was pushed" is a verdict and not a race. */
async function drainScheduledWork(): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
        await new Promise<void>(resolve => setImmediate(resolve));
    }
}

async function initialize(fixture: CodexMockTestFixture): Promise<void> {
    await fixture.getCodexAcpAgent().initialize({protocolVersion: PROTOCOL_VERSION});
}

describe("rateLimits extension", () => {
    it("pushes the windows of a ChatGPT login after its first auth status", async () => {
        const fixture = createCodexMockTestFixture();
        mockAccount(fixture, CHAT_GPT);
        vi.spyOn(fixture.getCodexAcpClient(), "getRateLimits").mockResolvedValue(rateLimitsResponse(CODEX_SNAPSHOT));

        await initialize(fixture);

        expect(await awaitRateLimitsUpdates(fixture, 1)).toEqual([CODEX_WINDOWS]);
    });

    it("names the model of a bucket that Codex ties to one", async () => {
        const fixture = createCodexMockTestFixture();
        mockAccount(fixture, CHAT_GPT);
        const spark: RateLimitSnapshot = {
            ...CODEX_SNAPSHOT,
            limitId: "codex_spark",
            limitName: "GPT-5.3-Codex-Spark",
            normalModelSlug: "gpt-5.3-codex-spark",
            secondary: null,
        };
        vi.spyOn(fixture.getCodexAcpClient(), "getRateLimits")
            .mockResolvedValue(rateLimitsResponse(CODEX_SNAPSHOT, spark));

        await initialize(fixture);

        const [update] = await awaitRateLimitsUpdates(fixture, 1);
        expect(update!.windows.at(-1)).toEqual({
            id: "codex_spark:primary",
            label: "GPT-5.3-Codex-Spark 5h limit",
            usedPercent: 38,
            resetsAt: "2026-10-22T15:40:00.000Z",
            windowMinutes: 300,
            model: "GPT-5.3-Codex-Spark",
        });
    });

    it("pushes no windows for an API key login, without a read", async () => {
        const fixture = createCodexMockTestFixture();
        mockAccount(fixture, {type: "apiKey"});
        const read = vi.spyOn(fixture.getCodexAcpClient(), "getRateLimits");

        await initialize(fixture);

        expect(await awaitRateLimitsUpdates(fixture, 1)).toEqual([{windows: []}]);
        expect(read).not.toHaveBeenCalled();
    });

    it("pushes nothing while nobody is logged in", async () => {
        const fixture = createCodexMockTestFixture();
        mockAccount(fixture, null);

        await initialize(fixture);
        await awaitFirstAuthStatusPush(fixture);
        await drainScheduledWork();

        expect(rateLimitsUpdates(fixture)).toEqual([]);
    });

    it("clears the windows of a login that logs out", async () => {
        const fixture = createCodexMockTestFixture();
        mockAccount(fixture, CHAT_GPT);
        vi.spyOn(fixture.getCodexAcpClient(), "getRateLimits").mockResolvedValue(rateLimitsResponse(CODEX_SNAPSHOT));
        await initialize(fixture);
        await awaitRateLimitsUpdates(fixture, 1);

        fixture.getCodexAcpAgent().handleAccountUpdated({authMode: null, planType: null});

        expect(await awaitRateLimitsUpdates(fixture, 2)).toEqual([CODEX_WINDOWS, {windows: []}]);
    });

    it("merges account/rateLimits/updated, which arrives also while no session exists", async () => {
        const fixture = createCodexMockTestFixture();
        mockAccount(fixture, CHAT_GPT);
        vi.spyOn(fixture.getCodexAcpClient(), "getRateLimits").mockResolvedValue(rateLimitsResponse(CODEX_SNAPSHOT));
        await initialize(fixture);
        await awaitRateLimitsUpdates(fixture, 1);

        fixture.sendServerNotification({
            method: "account/rateLimits/updated",
            params: {
                rateLimits: {
                    ...CODEX_SNAPSHOT,
                    limitId: null,
                    limitName: null,
                    planType: null,
                    primary: {usedPercent: 45, windowDurationMins: 300, resetsAt: FIVE_HOUR_RESET},
                },
            },
        });

        const [, update] = await awaitRateLimitsUpdates(fixture, 2);
        expect(update!.windows.map(window => [window.label, window.usedPercent])).toEqual([
            ["Codex 5h limit", 45],
            ["Codex Weekly limit", 59],
        ]);
    });

    it("drops a read that an update overtook", async () => {
        const fixture = createCodexMockTestFixture();
        mockAccount(fixture, CHAT_GPT);
        let answer!: (response: GetAccountRateLimitsResponse) => void;
        const read = vi.spyOn(fixture.getCodexAcpClient(), "getRateLimits")
            .mockReturnValue(new Promise(resolve => (answer = resolve)));
        await initialize(fixture);
        await vi.waitFor(() => expect(read).toHaveBeenCalled());

        fixture.sendServerNotification({
            method: "account/rateLimits/updated",
            params: {rateLimits: {...CODEX_SNAPSHOT, primary: {...CODEX_SNAPSHOT.primary!, usedPercent: 45}}},
        });
        await awaitRateLimitsUpdates(fixture, 1);
        answer(rateLimitsResponse(CODEX_SNAPSHOT));
        await drainScheduledWork();

        expect(rateLimitsUpdates(fixture).map(update => update.windows[0]!.usedPercent)).toEqual([45]);
    });

    it("reaches an ACP v2 client", async () => {
        const mocks = createMockConnections();
        const router = createAcpAgentRouter((connection) => {
            const codexAcpClient = new CodexAcpClient(new CodexAppServerClient(mocks.mockCodexConnection as any));
            vi.spyOn(codexAcpClient, "getAgentConfiguredModelProvider").mockResolvedValue("openai");
            vi.spyOn(codexAcpClient, "getAccount").mockResolvedValue({account: CHAT_GPT, requiresOpenaiAuth: true});
            vi.spyOn(codexAcpClient, "getRateLimits").mockResolvedValue(rateLimitsResponse(CODEX_SNAPSHOT));
            return new CodexAcpServer(connection, codexAcpClient);
        });
        const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
        const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
        router.connect(acp.ndJsonStream(agentToClient.writable, clientToAgent.readable));
        const updates: unknown[] = [];
        const connection = acpV2.client({name: "test-client"})
            .onNotification(RATE_LIMITS_UPDATE_METHOD, z.object({}).passthrough(), (ctx) => {
                updates.push(ctx.params);
            })
            .connect(acp.ndJsonStream(clientToAgent.writable, agentToClient.readable));

        try {
            const response = await connection.agent.request(acpV2.methods.agent.initialize, {
                protocolVersion: 2,
                info: {name: "test-client", version: "1.0.0"},
            });

            expect(response.capabilities?.auth?._meta?.["rateLimits"]).toEqual({});
            await vi.waitFor(() => expect(updates).toEqual([{rateLimits: CODEX_WINDOWS}]));
        } finally {
            connection.close();
        }
    });
});
