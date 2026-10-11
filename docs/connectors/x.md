# X — connector (verified against docs.x.com and api.x.com/2/openapi.json v2.170, 2026)

**Status:** livestream state only (`platform.status` + `platform.live`). **No chat.** Video to X goes through OBS RTMP (Media Studio Producer → Sources → RTMP stream key). Setup for streamers: `docs/setup/x.md`.

Code: `apps/hub/src/connectors/x/{auth,api,connector}.ts`.

## Auth
- OAuth 2.0 Authorization Code + PKCE (S256) with the streamer's own **public ("Native App") client**: client id only, no secret.
- Authorize: `https://x.com/i/oauth2/authorize?response_type=code&client_id&redirect_uri&scope&state&code_challenge&code_challenge_method=S256`.
- Scopes: `broadcast.read tweet.read users.read offline.access`.
- Redirect: `http://127.0.0.1:<HUB_PORT>/oauth/x/callback` (`GET`, never request-logged). X requires an exact match and, for local development, `http://127.0.0.1` rather than `localhost` (docs: developer apps → Callback URLs).
- Token: `POST https://api.x.com/2/oauth2/token`, form-encoded, `client_id` in the body, no Basic auth. Codes expire after about 30 s, so the callback exchanges them immediately.
- Refresh: `grant_type=refresh_token`. X rotates refresh tokens, so every refresh stores the new one and concurrent refreshes are deduplicated. Any 400/401 on refresh clears the tokens and reports "Reconnect X" (`connections.state` error).
- Stored in `.streamhub/secrets.json` under `x`: `clientId`, `accessToken`, `refreshToken`, `expiresAt`, `userId`, `username`.

## Endpoints used
| Call | Use |
| :- | :- |
| `GET /2/users/me` | `data.id`, `data.username` after sign-in (account label `@username`, user id for sources). |
| `GET /2/broadcasts?max_results=5&broadcast.fields=id,state,title,total_watching,start_ms,created_at_ms,source_id` | The authenticated user's broadcasts. A `RUNNING` one wins, otherwise the newest by `created_at_ms`. |
| `GET /2/users/:user_id/sources` | Allowlist-only, not in the public OpenAPI. `is_stream_active` of the broadcast's `source_id` (or of any source when there is no broadcast). |

Broadcast state mapping (docs: livestream-api/broadcasts/overview): `RUNNING` → `running`; `NOT_STARTED`, `PRE_PUBLISHED` → `scheduled`; `ENDED`, `TIMED_OUT`, `CANCELED` and unknown states → `ended`; no broadcasts → `none`. `total_watching` and `start_ms` are strings and are parsed to integers.

Source objects include the RTMP stream key. The API layer reads only `id` and `is_stream_active` and keeps nothing else.

## Behaviour
- Poll every 15 s while a broadcast is running or scheduled, 30 s otherwise. `platform.status`: `connecting` → `live` (running) / `offline` (anything else).
- Ingest: 400/401/403/404 from sources sets ingest to `unknown` for the rest of the connector session without retrying. Other ingest failures report `unknown` for that poll only.
- 401 on broadcasts: invalidate the token, refresh, back off. 403: report "Livestream API access" and retry every 10 minutes. 429: wait for `x-rate-limit-reset` (epoch seconds), at least 60 s. Other errors: `backoffDelay`.
- Stopped, disconnected or auth lost: `platform.live { platform: 'x', ingest: 'unknown', broadcast: 'none' }`.

## Access and pricing
- X's docs say the whole Livestream API (broadcasts included) is limited to approved apps, via the [access form](https://docs.x.com/forms/livestream-api-access). Without it, expect 403 on `GET /2/broadcasts`.
- Owned reads: $0.001 per resource since 2026-04-20, with the same resource billed once per 24 h.

## Chat (not built)
- Delivered via the X Activity API (XAA) `broadcast.chat` event, **webhooks only**, so it needs the relay. Past chat via Get Chat History (only after the broadcast ends).
- `broadcast.chat` pricing is not listed. Comparable events: `post.create` $0.005, `chat.received` $0.010. That could mean roughly $120–700/month per streamer at realistic volume, so chat stays deferred until pricing is known.

## Sources
- https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- https://docs.x.com/resources/fundamentals/developer-apps (Callback URLs)
- https://docs.x.com/livestream-api/authentication
- https://docs.x.com/livestream-api/broadcasts/overview
- https://docs.x.com/livestream-api/broadcasts/get-broadcasts
- https://docs.x.com/livestream-api/sources/list-sources
- https://docs.x.com/livestream-api/chat/accessing-live-chat
- https://docs.x.com/forms/livestream-api-access
- https://api.x.com/2/openapi.json
