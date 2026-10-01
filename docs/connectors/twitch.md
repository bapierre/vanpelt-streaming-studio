# Twitch connector — findings (2026-10-01)

Sourced from live dev.twitch.tv pages on 2026-10-01. JSON copied verbatim unless marked **ILLUSTRATIVE**. Not verified: the Developer Services Agreement (legal.twitch.com renders client-side and could not be read).

## 1. Summary / decision

- **Transport:** EventSub over WebSocket (`wss://eventsub.wss.twitch.tv/ws`). Twitch calls it "the best option" for apps running on the end user's machine. Webhooks need a public HTTPS URL on port 443 and an app token, which rules them out for a hub bound to 127.0.0.1.
- **Subscriptions:**
  - Required: `channel.chat.message` v1.
  - Recommended: `channel.chat.message_delete` v1, `channel.chat.clear` v1 and `channel.chat.clear_user_messages` v1, so moderated messages disappear from the dashboard and overlays.
  - All four need only `user:read:chat`.
- **Auth:**
  - Device Code Grant Flow (DCF) with the app registered as a **Public** client, so no client secret ships.
  - The streamer authorizes their own account, so `condition.broadcaster_user_id == condition.user_id == <streamer id>`.
- **Fallback:** IRC (`wss://irc-ws.chat.twitch.tv:443`) is still **Active**; only non-TLS WebSocket IRC was decommissioned (2025-08-15). EventSub + Helix is "the preferred method", so IRC is a fallback only.

## 2. Auth (Device Code Grant Flow)

**App registration**
- Register at dev.twitch.tv/console. The developer account needs 2FA.
- Set **Client Type = Public**. The docs: "for a more open platform (such as windows) we suggest using public."
- What Public means:
  - no client secret
  - refresh works without a secret
  - DCF only: "cannot use any of the other flows like client credentials, implicit grant flow"
- The client ID is public and can be embedded in OSS. However: "Do not share client IDs among applications". Forks register their own app.

**Step 1: start the flow**
```
POST https://id.twitch.tv/oauth2/device
Content-Type: application/x-www-form-urlencoded
client_id=<id>&scopes=user%3Aread%3Achat
```
The parameter is named `scopes` (plural), as documented.

Response:
```json
{
  "device_code": "ike3GM8QIdYZs43KdrWPIO36LofILoCyFEzjlQ91",
  "expires_in": 1800,
  "interval": 5,
  "user_code": "ABCDEFGH",
  "verification_uri": "https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH"
}
```
Open `verification_uri` and show `user_code`.

**Step 2: poll every `interval` seconds until `expires_in`**
```
POST https://id.twitch.tv/oauth2/token
client_id=<id>&scopes=user%3Aread%3Achat&device_code=<device_code>
&grant_type=urn:ietf:params:oauth:grant-type:device_code
```
Responses:
- Pending: `{"status": 400, "message": "authorization_pending"}`
- Code already used: `{"status": 400, "message": "invalid device code"}`. Codes are one-time use.
- Success: `{access_token, expires_in, refresh_token, scope[], token_type:"bearer"}`
- Unconfirmed: `slow_down`, `access_denied`, `expired_token` are not documented. Treat any other 400 as terminal.

**Tokens and refresh**
- Access tokens last about 4 hours (example `expires_in` 14820).
- **Public-client refresh tokens are one-time use.** Each refresh returns a new refresh token, which must be persisted atomically. Reusing an old one returns `{"status":400,"message":"Invalid refresh token"}`.
- **Refresh-token expiry is ambiguous.** The DCF page says it expires after 30 days *inactive*; the Refreshing page says "30 days after they are generated". Since each refresh mints a new token, re-auth is needed only after more than 30 days without a refresh. **Unconfirmed** whether there is an absolute cap.
- Refresh request: `POST https://id.twitch.tv/oauth2/token` with `grant_type=refresh_token&refresh_token=<urlencoded>&client_id=<id>`. No secret needed for Public clients.
- Twitch recommends refreshing reactively on a 401.
- At most 50 valid access tokens per refresh token, so do all refreshes in one place.
- If refresh fails, re-run DCF.

**Validation (required)**
- `GET https://id.twitch.tv/oauth2/validate` with header `Authorization: OAuth <token>`.
- "Your app must validate the OAuth token when it starts and on an hourly basis thereafter." This is audited; offenders get throttled or revoked.
- `200` returns `{client_id, login, scopes[], user_id, expires_in}`. Use `user_id` as the broadcaster id.
- `401` returns `{"status":401,"message":"invalid access token"}`. Refresh, and if that fails, stop the session.

## 3. EventSub WebSocket lifecycle

1. Connect to `wss://eventsub.wss.twitch.tv/ws`. Optionally add `?keepalive_timeout_seconds=10..600`.
2. Receive `session_welcome` and keep `payload.session.id`.
3. **Within 10 s of the welcome**, create the subscription:
   - `POST https://api.twitch.tv/helix/eventsub/subscriptions`
   - Headers: `Authorization: Bearer <user token>`, `Client-Id`, `Content-Type: application/json`
   - Body: `{"type":"channel.chat.message","version":"1","condition":{"broadcaster_user_id":B,"user_id":B},"transport":{"method":"websocket","session_id":S}}`
   - If no subscription arrives in time, Twitch closes the socket with 4003.
   - App access tokens fail on the WebSocket transport.
   - Responses:
     - `202`: enabled.
     - `409`: already exists. Since 2026-04-17 the response includes the existing `id`.
     - `403`: missing scope.
     - `401`: bad token, or `Client-Id` mismatch.
     - `429`: too many subscriptions with the same type and condition.
4. **Keepalive:**
   - If no notification or keepalive arrives within `keepalive_timeout_seconds`, reconnect and **resubscribe**. Lost events are not replayed.
   - Answer ping frames with pong (libraries do this). Pings do not reset the keepalive timer.
   - Any client-sent message closes the socket with 4001.
5. **`session_reconnect`:**
   - Connect to `reconnect_url` unchanged.
   - Subscriptions carry over; do not resubscribe.
   - Keep the old socket until the new socket's welcome arrives, then close the old one.
   - The whole handover must finish within 30 s, or the server closes with 4004.
   - Does not count against the connection limit.
6. **`revocation`** is sent once. Possible `subscription.status` values:
   - `authorization_revoked`: re-run DCF.
   - `user_removed`
   - `version_removed`
   - `chat_user_banned`
   - `moderator_removed`
   - `beta_maintenance`
7. **Close codes:**
   - 4000 internal error
   - 4001 inbound traffic
   - 4002 failed ping-pong
   - 4003 unused (no subscription in time)
   - 4004 reconnect grace expired
   - 4005 network timeout
   - 4006 network error
   - 4007 invalid reconnect URL
8. **Delivery is at least once.** De-duplicate on `metadata.message_id`; a resent notification keeps the same id.

After a drop, every subscription on the lost session is disabled. `GET /helix/eventsub/subscriptions` (filter on `transport.session_id`) is available for auditing.

## 4. Payloads (verbatim)

Notification envelope (the docs show it with `channel.follow`; chat uses the same envelope):
```json
{
    "metadata": {
        "message_id": "befa7b53-d79d-478f-86b9-120f112b044e",
        "message_type": "notification",
        "message_timestamp": "2022-11-16T10:11:12.464757833Z",
        "subscription_type": "channel.follow",
        "subscription_version": "1"
    },
    "payload": {
        "subscription": {
            "id": "f1c2a387-161a-49f9-a165-0f21d7a4e1c4",
            "status": "enabled",
            "type": "channel.follow",
            "version": "1",
            "cost": 1,
            "condition": {
                "broadcaster_user_id": "12826"
            },
            "transport": {
                "method": "websocket",
                "session_id": "AQoQexAWVYKSTIu4ec_2VAxyuhAB"
            },
            "created_at": "2022-11-16T10:11:12.464757833Z"
        },
        "event": {
            "user_id": "1337",
            "user_login": "awesome_user",
            "user_name": "Awesome_User",
            "broadcaster_user_id": "12826",
            "broadcaster_user_login": "twitch",
            "broadcaster_user_name": "Twitch",
            "followed_at": "2023-07-15T18:16:11.17106713Z"
        }
    }
}
```

`session_welcome`:
```json
{
  "metadata": {
    "message_id": "96a3f3b5-5dec-4eed-908e-e11ee657416c",
    "message_type": "session_welcome",
    "message_timestamp": "2023-07-19T14:56:51.634234626Z"
  },
  "payload": {
    "session": {
      "id": "AQoQILE98gtqShGmLD7AM6yJThAB",
      "status": "connected",
      "connected_at": "2023-07-19T14:56:51.616329898Z",
      "keepalive_timeout_seconds": 10,
      "reconnect_url": null
    }
  }
}
```

`session_keepalive`:
```json
{
    "metadata": {
        "message_id": "84c1e79a-2a4b-4c13-ba0b-4312293e9308",
        "message_type": "session_keepalive",
        "message_timestamp": "2023-07-19T10:11:12.634234626Z"
    },
    "payload": {}
}
```

`session_reconnect`:
```json
{
    "metadata": {
        "message_id": "84c1e79a-2a4b-4c13-ba0b-4312293e9308",
        "message_type": "session_reconnect",
        "message_timestamp": "2022-11-18T09:10:11.634234626Z"
    },
    "payload": {
        "session": {
           "id": "AQoQexAWVYKSTIu4ec_2VAxyuhAB",
           "status": "reconnecting",
           "keepalive_timeout_seconds": null,
           "reconnect_url": "wss://eventsub.wss.twitch.tv?...",
           "connected_at": "2022-11-16T10:11:12.634234626Z"
        }
    }
}
```

`revocation`:
```json
{
    "metadata": {
        "message_id": "84c1e79a-2a4b-4c13-ba0b-4312293e9308",
        "message_type": "revocation",
        "message_timestamp": "2022-11-16T10:11:12.464757833Z",
        "subscription_type": "channel.follow",
        "subscription_version": "1"
    },
    "payload": {
        "subscription": {
            "id": "f1c2a387-161a-49f9-a165-0f21d7a4e1c4",
            "status": "authorization_revoked",
            "type": "channel.follow",
            "version": "1",
            "cost": 1,
            "condition": {
                "broadcaster_user_id": "12826"
            },
            "transport": {
                "method": "websocket",
                "session_id": "AQoQexAWVYKSTIu4ec_2VAxyuhAB"
            },
            "created_at": "2022-11-16T10:11:12.464757833Z"
        }
    }
}
```

`channel.chat.message` "Regular Chat Message Example" (the `payload` inside the envelope):
```json
{
  "subscription": {
    "id": "0b7f3361-672b-4d39-b307-dd5b576c9b27",
    "status": "enabled",
    "type": "channel.chat.message",
    "version": "1",
    "condition": {
      "broadcaster_user_id": "1971641",
      "user_id": "2914196"
    },
    "transport": {
      "method": "websocket",
      "session_id": "AgoQHR3s6Mb4T8GFB1l3DlPfiRIGY2VsbC1h"
    },
    "created_at": "2023-11-06T18:11:47.492253549Z",
    "cost": 0
  },
  "event": {
    "broadcaster_user_id": "1971641",
    "broadcaster_user_login": "streamer",
    "broadcaster_user_name": "streamer",
    "chatter_user_id": "4145994",
    "chatter_user_login": "viewer32",
    "chatter_user_name": "viewer32",
    "message_id": "cc106a89-1814-919d-454c-f4f2f970aae7",
    "message": {
      "text": "Hi chat",
      "fragments": [
        {
          "type": "text",
          "text": "Hi chat",
          "cheermote": null,
          "emote": null,
          "mention": null
        }
      ]
    },
    "color": "#00FF7F",
    "badges": [
      {
        "set_id": "moderator",
        "id": "1",
        "info": ""
      },
      {
        "set_id": "subscriber",
        "id": "12",
        "info": "16"
      },
      {
        "set_id": "sub-gifter",
        "id": "1",
        "info": ""
      }
    ],
    "message_type": "text",
    "cheer": null,
    "reply": null,
    "channel_points_custom_reward_id": null,
    "source_broadcaster_user_id": null,
    "source_broadcaster_user_login": null,
    "source_broadcaster_user_name": null,
    "source_message_id": null,
    "source_badges": null
  }
}
```
In Shared Chat sessions, the `source_*` fields are non-null and there is also `is_source_only: true|false`.

Emote fragments, verbatim from "Send & receive messages / Handling Emotes" (whitespace compacted):
```json
"message": {
  "text": "RAID TombRaid RAID twitchRaid RAID",
  "fragments": [
    { "type": "text", "text": "RAID ", "cheermote": null, "emote": null, "mention": null },
    { "type": "emote", "text": "TombRaid", "cheermote": null,
      "emote": { "id": "864205", "emote_set_id": "0", "owner_id": "0", "format": ["static"] },
      "mention": null },
    { "type": "text", "text": " RAID ", "cheermote": null, "emote": null, "mention": null },
    { "type": "emote", "text": "twitchRaid", "cheermote": null,
      "emote": { "id": "62836", "emote_set_id": "0", "owner_id": "0", "format": ["static"] },
      "mention": null },
    { "type": "text", "text": " RAID", "cheermote": null, "emote": null, "mention": null }
  ]
}
```

**ILLUSTRATIVE** mention and cheermote fragments. These are built from the field reference; there is no official example:
```json
{ "type": "mention", "text": "@viewer32", "cheermote": null, "emote": null,
  "mention": { "user_id": "4145994", "user_name": "viewer32", "user_login": "viewer32" } }
{ "type": "cheermote", "text": "cheer100", "emote": null, "mention": null,
  "cheermote": { "prefix": "cheer", "bits": 100, "tier": 100 } }
```

Other fields:
- Fragment `type` is one of `text | cheermote | emote | mention | gif`.
  - `gif` was added 2026-07-16 and carries `gif: {id, url}`. Use `url` as is.
  - The changelog says `gif_id`; see Open questions.
- `message_type` is one of `text | channel_points_highlighted | channel_points_sub_only | user_intro | power_ups_message_effect | power_ups_gigantified_emote`.
- `reply`, when non-null, has `parent_message_id`, `parent_message_body`, `parent_user_*`, `thread_message_id` and `thread_user_*`.
- `cheer` is `{bits}`.
- `color` may be `""`.

`channel.chat.message_delete`:
```json
{
    "subscription": {
        "id": "f1c2a387-161a-49f9-a165-0f21d7a4e1c4",
        "type": "channel.chat.message_delete",
        "version": "1",
        "status": "enabled",
        "cost": 0,
        "condition": {
            "broadcaster_user_id": "1337",
            "user_id": "9001"
        },
         "transport": {
            "method": "webhook",
            "callback": "https://example.com/webhooks/callback"
        },
        "created_at": "2023-04-11T10:11:12.123Z"
    },
    "event": {
        "broadcaster_user_id": "1337",
        "broadcaster_user_name": "Cool_User",
        "broadcaster_user_login": "cool_user",
        "target_user_id": "7734",
        "target_user_name": "Uncool_viewer",
        "target_user_login": "uncool_viewer",
        "message_id": "ab24e0b0-2260-4bac-94e4-05eedd4ecd0e"
    }
}
```

Related events:
- `channel.chat.clear`: event is `{broadcaster_user_id, broadcaster_user_name, broadcaster_user_login}`. It means "reset all non-moderator chats to an empty state".
- `channel.chat.clear_user_messages`: same, plus `target_user_id`, `target_user_name` and `target_user_login`.

**Emote CDN**
- Template (from Get Global/Channel Emotes): `https://static-cdn.jtvnw.net/emoticons/v2/{{id}}/{{format}}/{{theme_mode}}/{{scale}}`
  - `format`: `static | animated`. Prefer `animated` when the fragment's `format[]` lists it.
  - `theme_mode`: `light | dark`.
  - `scale`: `1.0 | 2.0 | 3.0`.
- Example: `https://static-cdn.jtvnw.net/emoticons/v2/62836/static/light/3.0`.
- Twitch prefers filling in the API's `template`. A hard-coded template is fine as a fallback.

## 5. Role mapping and timestamps

| Role | `badges[].set_id` | Status |
|---|---|---|
| owner (broadcaster) | `broadcaster` | confirmed. Also derivable: `chatter_user_id == broadcaster_user_id` |
| moderator | `moderator` | confirmed |
| vip | `vip` | confirmed |
| subscriber | `subscriber` (`info` = months) | confirmed |
| subscriber | `founder` | **unconfirmed**. Treat as subscriber |
| moderator | `lead_moderator` | **unconfirmed** |

- **Badges:** read them from every message; don't cache them. Ignore `source_badges` for roles (it describes the source channel in Shared Chat).
- **Timestamp:** the event has no timestamp field. Use `metadata.message_timestamp` ("The UTC date and time that the message was sent"). It is RFC3339 with nanoseconds, so trim to milliseconds before passing it to `Date`.
- **Identity:** `event.message_id` is the stable chat-message id; `message_delete` refers to it. `metadata.message_id` is only for de-duplicating deliveries.

## 6. Limits and ToS

- **WebSocket limits.** Counted per user token, i.e. per client ID + user pair:
  - at most 3 WebSocket connections with enabled subscriptions
  - at most 300 enabled subscriptions per connection
  - `max_total_cost` 10
  
  Chat subscriptions cost 0 when the token belongs to the condition user. One socket is enough.
- **Helix rate limit.** Token bucket per client ID per user per minute; the docs' example shows `Ratelimit-Limit: 800`. On a 429, wait until `Ratelimit-Reset`.
- **Compliance:**
  - Validate tokens hourly (audited).
  - Don't share a client ID across apps.
  - End the session when validation fails or a revocation arrives.
  - Honour `message_delete` and `clear` in displays and logs.
- **Not verified:** the Developer Services Agreement's data-retention terms.

## 7. Open questions

1. Is the Public refresh-token expiry measured from last use or from issue? Test by refreshing on day 29 and day 31.
2. Are there DCF poll errors other than `authorization_pending`?
3. Do the `founder` and `lead_moderator` set_ids exist? Check with Get Global Chat Badges.
4. Is the gif fragment's id field `id` or `gif_id`?
5. Does selecting the Public client type need approval?
6. What do the Developer Services Agreement retention clauses say?
7. Can the 10 s welcome-to-subscribe window be extended?

## 8. Sources (fetched 2026-10-01)

- https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
- https://dev.twitch.tv/docs/eventsub/websocket-reference/
- https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/
- https://dev.twitch.tv/docs/eventsub/eventsub-reference/
- https://dev.twitch.tv/docs/api/reference/ (create/get EventSub subscriptions, global emotes, global chat badges)
- https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow
- https://dev.twitch.tv/docs/authentication/refresh-tokens/
- https://dev.twitch.tv/docs/authentication/validate-tokens/
- https://dev.twitch.tv/docs/authentication/register-app/
- https://dev.twitch.tv/docs/authentication/scopes/
- https://dev.twitch.tv/docs/chat/ , /chat/authenticating/ , /chat/send-receive-messages/ , /chat/irc/
- https://dev.twitch.tv/docs/api/guide/#twitch-rate-limits
- https://dev.twitch.tv/docs/product-lifecycle/
- https://dev.twitch.tv/docs/change-log/
