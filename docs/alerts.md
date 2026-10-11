# Alerts and goals

When someone follows, subscribes, gifts subs, cheers, sends a Super Chat or raids, a card pops up on stream with a sound. Goal bars show progress toward a number of followers, subs or tips. Everything comes straight from Twitch and YouTube through the connections you already use for chat, so there is no StreamElements or Streamlabs account and nothing to pay for.

## What shows up

| Alert | Twitch | YouTube |
|---|---|---|
| Follow | New follower | (none: YouTube does not report new subscribers live) |
| Sub | New sub, Prime included | New member |
| Resub | Resub with months | Membership milestone |
| Gift subs | Gifted subs, one alert per gift | Gifted memberships |
| Cheer | Bits | (none) |
| Tip | (none: bits are cheers) | Super Chat, Super Sticker |
| Raid | Raid with viewer count | (none) |

Alerts play one at a time, so a gift of 50 subs or a busy raid never stacks cards on top of each other. If Twitch sends the same event twice, it shows once. Someone who unfollows and follows again does not get a second alert.

## 1. Let Twitch share follows and subs

Twitch needs two permissions that chat alone did not: followers and subscriptions. If you connected Twitch before alerts existed, go to **Settings → Platforms → Twitch** and press **Connect** again, then approve. Until you do, chat and the other alerts keep working, and Settings → Alerts says "Reconnect Twitch to turn on follower alerts."

YouTube needs nothing new.

## 2. Add the pop-up to OBS

1. Open **Settings → Alerts**. Copy the **Alert pop-up** URL (it looks like `http://127.0.0.1:4748/m/alerts/popup.html` — module pages live on their own port).
2. In OBS, add a **Browser** source to every scene that should show alerts (or to a scene you nest into the others). Paste the URL, set width 1920 and height 1080, and leave the custom CSS empty. The page is transparent; the card appears near the top.
3. In the Browser source properties, tick **Control audio via OBS** so the alert sounds go through the OBS mixer and into the stream and recording.
4. Press **Test** next to any alert type. The card should appear in OBS.

If the alert URL is missing and the panel says the overlays are not built, run `pnpm build` (or keep `pnpm dev` running). The desktop app ships them built.

## 3. Choose what each alert does

Each alert type has a switch (on or off), a **Test** button, and **Text, sound and timing**:

- **Text:** what the card says. Use `{user}`, `{amount}`, `{count}`, `{months}` and `{tier}`; the preview under the box shows the result. Press **Save**.
- **Sound:** chime, pop, coin, fanfare, or none. **Volume** sets how loud.
- **On screen for:** 2 to 30 seconds.
- **Smallest cheer / tip / raid / gift:** smaller ones do not pop up (they still count toward goals). 0 shows all of them. Tips compare in the tip's own currency.

**Pause alerts** holds new alerts until you untick it (useful during an interview); they then play in order. **Skip current** removes the card on screen now. **Recent alerts** lists the last ones, with **Replay** to show one again. Test alerts are marked **Test** and never count toward a goal.

## 4. Add goals

Open **Settings → Goals** and fill in **New goal**:

- **Name:** what the bar says, e.g. "Road to 100 followers".
- **Counts:** followers, subs or tips, and from when:
  - **This stream:** starts at 0 when you go live. If the stream drops and you are back within 15 minutes, the count carries on.
  - **Channel total:** your channel's whole count. Twitch is exact; YouTube rounds its subscriber count, so the bar shows `~`. YouTube does not share a member total, so a total subs goal counts Twitch only.
  - Tips goals count either this stream or everything since you made the goal, in one currency (e.g. USD). Tips in other currencies are not counted. Twitch has no tips, so tips goals count YouTube.
- **Target** and **Platforms**.

Each goal gets its own URL. Add one Browser source per goal bar in OBS (1920 × 1080; the bar sits at the bottom). **Reset** puts a stream or tips goal back to 0. **Edit** changes it; changing what it counts starts it again from 0.

## Troubleshooting

- **Test works but real alerts do not:** check that Twitch or YouTube shows **connected** in Settings → Platforms. YouTube alerts only arrive while you have a live broadcast with chat.
- **No follow alerts from Twitch:** reconnect Twitch (step 1).
- **The total goal says "No follower count from Twitch yet":** totals refresh every few minutes; wait, or check the Twitch connection.
- **No sound:** tick **Control audio via OBS** in the Browser source, and check the source is not muted in the OBS mixer.

Settings and goals are saved in `.streamhub/alerts.json`. How each platform reports these events: `docs/connectors/alerts.md`.
