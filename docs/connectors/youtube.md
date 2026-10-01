# YouTube Live Chat connector — findings (2026-10-01)

Sourced from live developers.google.com pages on 2026-10-01.

Three findings change the design:
1. YouTube's developer policy **forbids embedding API credentials in open-source projects**.
2. `messageDeletedEvent` was **removed from the docs on 2026-06-23**.
3. **`streamList` quota cost is undocumented.**

## Summary / decision

- **Delivery:**
  - Primary: `liveChatMessages.streamList` over gRPC (`@grpc/grpc-js` + `@grpc/proto-loader`). Messages are pushed as they arrive, which meets the ~2 s target.
  - Fallback: poll `liveChatMessages.list`, honouring `pollingIntervalMillis`.
- **Finding the chat:** `liveBroadcasts.list?part=snippet&broadcastStatus=active&broadcastType=all` and read `snippet.liveChatId`. When nothing is live, report `offline` and re-check about every 60 s.
- **Auth:** OAuth 2.0 for installed apps, with a loopback redirect, PKCE and scope `https://www.googleapis.com/auth/youtube.readonly`.
- **Credentials:** policy rules out credentials in the repo. Options are discussed in the M2 decision (bring your own Google Cloud project vs. a hosted OAuth project). Quota is **per Google Cloud project**.
- **Deletions:** best effort only (see Payloads).

## Auth

- **Flow:** "OAuth 2.0 for Mobile & Desktop Apps".
  - Redirect to `http://127.0.0.1:<port>` (or `[::1]`) on a short-lived listener.
  - Out-of-band copy/paste and custom URI schemes "are no longer supported".
  - PKCE `code_verifier` is 43–128 characters.
- **Client secret:** Google says installed apps "cannot keep secrets", and the secret "is obviously not treated as a secret". The token endpoint now marks `client_secret` as **Optional** for both the code exchange and refresh. **Unconfirmed** whether a "Desktop app" client accepts requests without it. Send it if available.
- **Scope:** `youtube.readonly` ("View your YouTube account").
  - `liveBroadcasts.list` accepts readonly, youtube or force-ssl.
  - The discovery doc (rev 20260924) lists readonly for `liveChatMessages.list`.
  - Sending chat or moderating would need `youtube.force-ssl` (out of scope).
- **Verification:**
  - All YouTube scopes are **sensitive** (not restricted). This comes from a third-party source; Google's scope table wasn't checked.
  - Unverified apps show an "unverified app" screen.
  - External consent screen in **Testing**: refresh tokens expire after **7 days**, and only listed test users (up to 100) can sign in.
  - **Unconfirmed** whether a single-user "In production" unverified app avoids the 7-day expiry. The docs tie that rule only to "Testing".
- **Refresh tokens otherwise:**
  - They last until revoked, unused for 6 months, or the password changes.
  - At most 100 live tokens per account per client; the oldest is silently invalidated.
- **API key only:** streamList accepts an API key (`x-goog-api-key`), but an API key can't call `liveBroadcasts.list` with `mine`/`broadcastStatus`. Finding your own broadcast still needs OAuth, or a manually entered video id plus `videos.list`.

## Finding the live chat

1. `GET https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status&broadcastStatus=active&broadcastType=all` (OAuth, 1 unit).
   - Specify exactly one of `mine`, `broadcastStatus` or `id`.
   - `broadcastType` defaults to `event`. Without `all`, the "Go Live now" default broadcast is missed.
   - Use `items[0].snippet.liveChatId`. If `items` is empty, the channel is `offline`.
2. Alternative when you know the video id: `videos.list?part=liveStreamingDetails&id=…` (1 unit) and read `liveStreamingDetails.activeLiveChatId`. It is present only while the broadcast is live with chat.
3. **Offline re-check costs 1 unit per check.** Over 24 h that is 1,440 units at 60 s, or 2,880 at 30 s.
   - Use 60 s by default, 15 s for 5 minutes after "I'm going live", and stop when the hub is idle.
   - Avoid `search.list`, which has its own bucket of 100 calls/day.
4. **End of stream** is signalled by any of these; go back to step 1:
   - `offlineAt` appears in a response.
   - A `chatEndedEvent` arrives (not sent for the default broadcast).
   - Error `liveChatEnded` (403) or gRPC `FAILED_PRECONDITION` (9). gRPC uses the same code for disabled and ended chats.

## Delivery: streamList vs polling

**streamList (gRPC):**
- Documented with no preview label, so treated as GA. It has been in the docs since at least the 2025-07-14 revision.
  - The streamList reference calls it "the most efficient way to consume live chat messages".
  - The `list` page now says to use streamList for polling.
- Endpoint: `dns:///youtube.googleapis.com:443`, TLS. Service `youtube.api.v3.V3DataLiveChatMessageService/StreamList` (server streaming).
- Proto: published on the guide page as `stream_list.proto` (proto2).
  - It uses `google.protobuf.Duration` without importing it, so add `import "google/protobuf/duration.proto";`.
  - Enum names differ from REST (`TEXT_MESSAGE_EVENT`, `gift_details` vs `giftEventDetails`).
- Auth metadata: `authorization: Bearer <token>` or `x-goog-api-key`.
- Node: `@grpc/proto-loader` (with include dirs for Duration), `grpc.credentials.createSsl()`, `stub.StreamList(req, metadata)`, handling `data`/`end`/`error`.
- **Reconnection:**
  - Every response carries `nextPageToken`. After a disconnect, pass the last one as `pageToken` and the API resumes from there.
  - Reconnect with exponential backoff and de-duplicate by `id`. A `giftEvent` reuses its id to update the combo count.
  - The first connect without a token sends recent history. Drop items with `publishedAt` before the connect time if you don't want the backlog.
  - `RESOURCE_EXHAUSTED` (8) / `rateLimitExceeded` means you are reconnecting too fast.
- Request fields: `maxResults` is "not used in the streaming RPC". `profileImageSize` is 16–720 (default 88).
- An undocumented REST variant exists: `GET https://youtube.googleapis.com/youtube/v3/liveChat/messages/stream` (not in discovery). Don't depend on it.
- **Quota: not documented.** Community claims range from "1 per response" (~1,672 units/h) to "~5 per connection". **Measure it** on a test project.

**Polling (fallback):**
- `GET https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=…&part=snippet,authorDetails&pageToken=…`
- Wait `pollingIntervalMillis` between calls; polling faster returns `rateLimitExceeded`.
- Latency is roughly the interval (typical values undocumented). It probably misses the 2 s target.

## Quota math

- 10,000 units/day **per project**, reset at midnight Pacific time.
- Costs:
  - `liveBroadcasts.list` = 1
  - `videos.list` = 1
  - `liveChatMessages.list` = **1** (official 2026 table; community sources still say 5)
  - `streamList` is not listed

| Mode | Interval | Calls/h | Units/h @1 | Max h/day @1 | Units/h @5 | Max h/day @5 |
|---|---|---|---|---|---|---|
| list | 2 s | 1,800 | 1,800 | 5.5 | 9,000 | 1.1 |
| list | 5 s | 720 | 720 | 13.9 | 3,600 | 2.8 |
| list | 8 s | 450 | 450 | 22.2 | 2,250 | 4.4 |
| streamList | push | ~1 per (re)connect* | ≪100* | ~24* | — | — |
| streamList | if ~1/response | ~1,672 (claimed) | 1,672 | ~6 | — | — |

\*Assumes per-connection billing (unverified).

**Does a 3–4 h stream fit?**
- Polling at 1 unit/call: yes at any interval of 2 s or more.
- Polling at 5 units/call: only at about 8 s or more.
- streamList: very likely yes.

Add about 60 units/h for offline re-checks.

**Shared project:** if every streamhub user went through one project, they would all share 10,000 units/day. A single 4 h stream at 5 s polling uses about 29% of that. Raising the limit requires a YouTube API Compliance Audit.

## Payloads (verbatim from the reference, including its stray trailing commas)

```json
{
  "kind": "youtube#liveChatMessage",
  "etag": etag,
  "id": string,
  "snippet": {
    "type": string,
    "liveChatId": string,
    "authorChannelId": string,
    "publishedAt": datetime,
    "hasDisplayContent": boolean,
    "displayMessage": string,
    "fanFundingEventDetails": {
      "amountMicros": unsigned long,
      "currency": string,
      "amountDisplayString": string,
      "userComment": string
    },
    "textMessageDetails": {
      "messageText": string
    },
    "userBannedDetails": {
      "bannedUserDetails": {
        "channelId": string,
        "channelUrl": string,
        "displayName": string,
        "profileImageUrl": string
      },
      "banType": string,
      "banDurationSeconds": unsigned long
    },
    "memberMilestoneChatDetails": {
      "userComment": string,
      "memberMonth": unsigned integer,
      "memberLevelName": string
    },
    "newSponsorDetails": {
      "memberLevelName": string,
      "isUpgrade": bool
    },
    "superChatDetails": {
      "amountMicros": unsigned long,
      "currency": string,
      "amountDisplayString": string,
      "userComment": string,
      "tier": unsigned integer
    },
    "superStickerDetails": {
      "superStickerMetadata": {
        "stickerId": string,
        "altText": string,
        "language": string
      },
      "amountMicros": unsigned long,
      "currency": string,
      "amountDisplayString": string,
      "tier": unsigned integer
    },
    "pollDetails": {
      "metadata": {
        "options": {
          "optionText": string,
          "tally": string,
        },
        "questionText": string,
        "status": enum
      },
    },
    "membershipGiftingDetails": {
      "giftMembershipsCount": integer,
      "giftMembershipsLevelName": string
    },
    "giftMembershipReceivedDetails": {
      "memberLevelName": string,
      "gifterChannelId": string,
      "associatedMembershipGiftingMessageId": string
    },
    "giftEventDetails": {
      "giftMetadata": {
        "jewelsAmount": integer,
        "giftName": string,
        "giftUrl": string,
        "giftDuration": object,
        "seconds": integer,
        "nanos": integer,
        "hasVisualEffect": boolean,
        "comboCount": integer,
        "altText": string,
        "language": string
      },
    },
  },
  "authorDetails": {
    "channelId": string,
    "channelUrl": string,
    "displayName": string,
    "profileImageUrl": string,
    "isVerified": boolean,
    "isChatOwner": boolean,
    "isChatSponsor": boolean,
    "isChatModerator": boolean
  },
}
```

List/stream response:
```json
{
  "kind": "youtube#liveChatMessageListResponse",
  "etag": etag,
  "nextPageToken": string,
  "pollingIntervalMillis": unsigned integer,
  "offlineAt": datetime,
  "pageInfo": {
    "totalResults": integer,
    "resultsPerPage": integer
  },
  "items": [
    liveChatMessage Resource
  ],
  "activePollItem": liveChatMessage Resource
}
```

**`snippet.type` values (2026):**
- `textMessageEvent`
- `superChatEvent`
- `superStickerEvent`
- `newSponsorEvent`
- `memberMilestoneChatEvent`
- `membershipGiftingEvent`
- `giftMembershipReceivedEvent`
- `giftEvent` (added 2026-03-26)
- poll: `pollDetails`, `pollEvent` or `POLL_EVENT` in the proto; handle all three
- `userBannedEvent`
- `sponsorOnlyModeStartedEvent`
- `sponsorOnlyModeEndedEvent`
- `chatEndedEvent`
- `tombstone`
- `fanFundingEvent` (deprecated)

**Deletions:** revision history for 2026-06-23 says "All references to the messageDeletedEvent and messageRetractedEvent resource types … have been removed as these events are not being returned by the API."
- `tombstone` "is not sent upon deletion … but rather is shown to signify where the message used to be". It carries only `liveChatId`, `type` and `publishedAt`.
- **Unconfirmed** whether `tombstone.id` equals the deleted message id. If it does, use it to retract the message. Otherwise, deletions are not detectable.

**Text and emoji:**
- `displayMessage` and `textMessageDetails.messageText` are plain strings, and Unicode emoji arrive as characters.
- There are no emote image URLs or rich runs. Custom channel emoji probably appear as `:shortcode:` text (**unconfirmed**).
- Super Sticker images aren't provided either, only `stickerId` and `altText`.
- Render as escaped text.

## Role mapping

| YouTube | streamhub role |
|---|---|
| `isChatOwner` | `owner` |
| `isChatModerator` | `moderator` |
| `isChatSponsor` | `member` |
| none | `[]` |

`isVerified` has no role equivalent and there is no VIP. Use `authorDetails.channelId` as the user id and `displayName` as the name.

## Policy (YouTube API Services Developer Policies, last updated 2026-09-14)

- **III.D.1.c:** one API project per API client, and you "must not … embed your API Credentials in open source projects".
- **III.A:** the client must link to YouTube's Terms of Service and have a privacy policy that links Google's Privacy Policy. Show both on the setup screen.
- **III.F.2:** make it clear that YouTube is the source. Show a YouTube icon on YouTube messages.
- **III.E.4:** don't store Authorized Data longer than 30 days. Keep chat in memory, or rotate any logs at 30 days or less.
- **III.E.8:** no "new or derived data or metrics" from API data. Avoid persisting chat aggregates.
- **III.D.3:** quota increases go through an API Compliance Audit.

## Open questions

1. Is streamList billed per connection or per response? Measure it.
2. Does the Desktop client token exchange work without `client_secret`?
3. Does a single-user "In production" unverified project avoid the 7-day refresh expiry?
4. Does `liveChatMessages.list` cost 1 unit or 5?
5. Does `tombstone.id` equal the deleted message id?
6. What text format do custom emoji use?
7. How stable is the REST `/liveChat/messages/stream` endpoint?
8. What are typical `pollingIntervalMillis` values?

## Sources

- https://developers.google.com/youtube/v3/live/docs/liveChatMessages (and /streamList, /list)
- https://developers.google.com/youtube/v3/live/streaming-live-chat
- https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list
- https://developers.google.com/youtube/v3/docs/videos
- https://developers.google.com/youtube/v3/determine_quota_cost
- https://developers.google.com/youtube/v3/revision_history (2026-06-23, 2026-06-01)
- https://developers.google.com/youtube/v3/live/revision_history
- https://developers.google.com/youtube/v3/guides/auth/installed-apps
- https://developers.google.com/identity/protocols/oauth2/native-app
- https://developers.google.com/identity/protocols/oauth2
- https://developers.google.com/youtube/terms/developer-policies
- https://youtube.googleapis.com/$discovery/rest?version=v3
- Community (unofficial): https://github.com/dipaadipati/yt-livechat-grpc , https://github.com/Voidscape-Development/Social-Feed/pull/2
