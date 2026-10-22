# Rate limits extension

Status: Experimental

This document is the wire contract of the `rateLimits` extension.
It reports how much of its plan's usage limits the agent's own login has used, as data: the windows `/status` shows, such as the 5-hour and the weekly window of a ChatGPT plan.

A client can then show the limits before the first prompt of a session, without sending `/status` and without reading any credential itself.
ACP has no rate limit API yet. The [session usage RFD](https://agentclientprotocol.com/rfds/session-usage) leaves rate limits and quotas to a later RFD.
When one lands, the payload moves there and this extension is retired.
`claude-agent-acp` sends the same notification with the same payload.

## Negotiation

The `initialize` response advertises the extension with an empty object next to `authStatus`:
`agentCapabilities._meta.rateLimits` on ACP v1, `capabilities.auth._meta.rateLimits` on ACP v2.

```json
{ "agentCapabilities": { "_meta": { "authStatus": {}, "rateLimits": {} } } }
```

The marker carries no payload. The client declares nothing: a client that does not know the notification drops it.

## Notification

The agent pushes `_auth/rate_limits_update`. It is connection-scoped, like `_auth/status_update`, because the limits belong to the login, not to a session.

```json
{
  "method": "_auth/rate_limits_update",
  "params": {
    "rateLimits": {
      "windows": [
        {
          "id": "codex:primary",
          "label": "Codex 5h limit",
          "usedPercent": 38,
          "resetsAt": "2026-10-22T15:40:00.000Z",
          "windowMinutes": 300
        },
        {
          "id": "codex:secondary",
          "label": "Codex Weekly limit",
          "usedPercent": 59,
          "resetsAt": "2026-10-26T09:00:00.000Z",
          "windowMinutes": 10080
        }
      ]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `windows` | Every window that applies to the login, in the order `/status` shows them: each bucket of `account/rateLimits/read`, its primary window before its secondary one. Each update replaces the whole list. |
| `id` | Stable for the same window across updates, unique in the list: `<limitId>:primary` or `<limitId>:secondary`. |
| `label` | Human-readable and usable as a UI string on its own: the bucket's `limitName` and the window's length. |
| `usedPercent` | Share of the window used, 0–100. |
| `resetsAt` | When the window resets, as an ISO 8601 date-time. Absent when Codex does not say. |
| `windowMinutes` | Length of the window, such as 300 or 10080. Absent when Codex does not say. |
| `model` | Present for a bucket that Codex ties to a model (`normalModelSlug`): the bucket's `limitName`. Not a model id. |

`windows: []` means the login has no plan limits: an API key, Amazon Bedrock, or a gateway.
"Cannot determine" is silence: the agent pushes nothing, and the client shows nothing.
That is the case of a failed read, and of a connection where nobody is logged in.

## When the agent pushes

- After each change of the auth status to a ChatGPT login, from `account/rateLimits/read`. The first auth status of the connection, pushed after `initialize`, is such a change.
- On each app-server `account/rateLimits/updated`, which Codex sends while turns run. The update is merged into the last read the way `/status` merges it. A read that such an update overtook is dropped.
- `windows: []` after a change to a login without plan limits, and after a logout that follows a push of windows.

The agent pushes only when the payload differs from the last one it pushed.
