# Alerts and goals: platform sources (2026-10-11)

Where each alert and each goal count comes from, checked against the official Twitch and YouTube docs. No third-party alert service (StreamElements, Streamlabs) is used: the events arrive on the connections the hub already has for chat.

## 1. Summary / decision

- **Twitch:** two more EventSub subscriptions on the existing WebSocket session (`channel.chat.notification` v1 and `channel.follow` v2), plus the `cheer` field on `channel.chat.message`, which the connector already receives.
- **YouTube:** the live chat stream the connector already reads carries Super Chats, Super Stickers and membership events as message types, so no extra calls are needed for alerts.
- **Totals for "channel total" goals:** Twitch Get Channel Followers and Get Broadcaster Subscriptions every 5 minutes; YouTube channel statistics at most every 10 minutes.
- **Tips** are platform money only for now: YouTube Super Chats and Super Stickers. Twitch bits are cheers, not tips. Ko-fi and other tip pages would arrive through the relay (follow-up).
- **Kick** alerts wait for the relay (M3); `kick` is already a valid alert platform in the contract.

## 2. Twitch

Docs: [EventSub subscription types](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/), [EventSub reference](https://dev.twitch.tv/docs/eventsub/eventsub-reference/), [API reference](https://dev.twitch.tv/docs/api/reference/), [scopes](https://dev.twitch.tv/docs/authentication/scopes/).

**Scopes** (`apps/hub/src/connectors/twitch/auth.ts`): `user:read:chat moderator:read:followers channel:read:subscriptions`. A sign-in from before alerts lacks the last two. Then `channel.follow` returns 403; the connector keeps chat running and sets its status detail to "Reconnect Twitch to turn on follower alerts." Without `channel:read:subscriptions`, the sub total is left out of `platform.totals`.

**Subscriptions**
| type | version | condition | scope | used for |
|---|---|---|---|---|
| `channel.chat.notification` | 1 | `broadcaster_user_id`, `user_id` | `user:read:chat` | subs, resubs, gift subs, raids |
| `channel.follow` | 2 | `broadcaster_user_id`, `moderator_user_id` (the streamer) | `moderator:read:followers` | follows |
| `channel.chat.message` | 1 | (already used for chat) | `user:read:chat` | cheers (`cheer.bits`) |

**`channel.chat.notification` → alerts** (`twitch/alerts.ts`)
| `notice_type` | alert | fields |
|---|---|---|
| `sub` | `sub` | `sub.sub_tier` (`1000`/`2000`/`3000` → `1`/`2`/`3`), `sub.is_prime` → `Prime` |
| `resub` | `resub` | `resub.cumulative_months`, tier, `message.text` |
| `community_sub_gift` | `giftsub` | `community_sub_gift.total` as `count` |
| `sub_gift` | `giftsub` (count 1) | only when `community_gift_id` is empty; otherwise it is one of the subs inside a community gift that already has its own notice, and is skipped |
| `raid` | `raid` | `raid.viewer_count` as `count`, `raid.profile_image_url` as avatar |
| `shared_chat_*`, others | none | shared-chat copies come from other channels |

- The alert id is `twitch:<message_id>` from the event, so a redelivered notification is dropped.
- `chatter_is_anonymous` gifts show as "Anonymous".
- **Follows:** id `twitch:<EventSub message id>` (the follow event has no id of its own). The alert service also drops a second follow by the same user (unfollow then follow again).
- **Cheers:** id `twitch:cheer:<message_id>`; the message text drops the cheermote fragments (`Cheer100`), so only what the viewer wrote is shown.

**Totals**
- `GET /helix/channels/followers?broadcaster_id=<id>&first=1`: `total` is the follower count.
- `GET /helix/subscriptions?broadcaster_id=<id>&first=1`: `total` is the paid sub count (needs `channel:read:subscriptions`).

## 3. YouTube

Docs: [liveChatMessages](https://developers.google.com/youtube/v3/live/docs/liveChatMessages), [channels](https://developers.google.com/youtube/v3/docs/channels).

**`snippet.type` → alerts** (`youtube/alerts.ts`)
| type | alert | fields |
|---|---|---|
| `superChatEvent` | `tip` | `superChatDetails.amountMicros` / 1,000,000, `currency`, `amountDisplayString`, `userComment` |
| `superStickerEvent` | `tip` | `superStickerDetails` (same money fields) |
| `newSponsorEvent` | `sub` | `newSponsorDetails.memberLevelName` as tier |
| `memberMilestoneChatEvent` | `resub` | `memberMilestoneChatDetails.memberMonth` as months, `userComment` |
| `membershipGiftingEvent` | `giftsub` | `membershipGiftingDetails.giftMembershipsCount` as count |
| `giftMembershipReceivedEvent` | none | one per recipient of a gift already shown |

- `amountMicros` is a string in the REST API and a number in the gRPC stream; both are read.
- The alert id is `youtube:<message id>`. Alerts share the chat connector's duplicate check and backlog cut-off: old events YouTube sends when the connector (re)joins a chat are not replayed as alerts.

**Totals:** `channels.list?part=statistics&mine=true`. `subscriberCount` is rounded by YouTube to three significant figures, so goals using it are marked approximate (`~`). When `hiddenSubscriberCount` is true there is no total. YouTube has no API for a channel's member count, so sub goals with the `total` scope count Twitch only.

## 4. Not verified

- Whether every Twitch "Prime" sub reports `is_prime` on `resub` as well as `sub`.
- How YouTube reports a Super Chat in a currency without minor units (e.g. JPY); the overlay uses `amountDisplayString` as given.
