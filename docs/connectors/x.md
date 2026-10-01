# X — connector findings (2026-10-01)

**Status:** chat deferred. Video to X works via RTMP (Media Studio Producer → Sources → RTMP stream key) through obs-multi-rtmp.

## Chat API
- Delivered via the X Activity API (XAA) `broadcast.chat` event, **webhooks only** (no persistent stream). Live only; past chat via Get Chat History.
- OAuth 2.0 PKCE, `broadcast.read` scope, token must belong to the broadcaster. One subscription per broadcaster.
- Livestream API (rebuilt 2026-09-22) is **whitelisted per app** via the access form (asks for current plan + monthly active users). The official docs changelog lists it **under the Enterprise plan**.

## Pricing (unconfirmed)
- Public X API model: pay-per-use credits; webhook events billed per delivered event (deduped per 24h UTC window).
- `broadcast.chat` is **not listed**. Comparable events: `post.create` $0.005, `chat.received` $0.010.
- If billed alike: ~$120–700/month per streamer at realistic volume (3h/week, 5 msg/s peak). A shared relay at 10–100 streamers ≈ $1k–70k/month.
- Unknown: Enterprise price, whether `broadcast.chat` is billable, subscription/user caps, terms on relaying chat for others.

## Next steps
1. Submit the Livestream API access form; ask for `broadcast.chat` pricing and whether a multi-tenant relay is acceptable.
2. If affordable → add `x` as a relay platform. Otherwise → "bring your own X app" on a self-hosted relay.

## Sources
- https://docs.x.com/livestream-api/chat/accessing-live-chat
- https://docs.x.com/forms/livestream-api-access
- https://docs.x.com/x-api/getting-started/pricing
- https://docs.x.com/livestream-api/introduction
- https://github.com/xdevplatform/docs/pull/420
