# Connect X (bring your own X app)

streamhub shows whether your X livestream is scheduled, running or ended, with the viewer count. It does not show X chat. Your video still goes to X through OBS (see `docs/multistream.md`).

X API access is tied to a developer app and billed per use, so you create your own app once (about 5 minutes) and pay X directly for your own reads.

## One-time: create your X app
1. Open https://developer.x.com/console and sign in with the X account you stream from. Set up pay-per-use billing if the console asks.
2. **Apps → Create app.** Any name works (e.g. `streamhub`).
3. Open the app → **User authentication settings → Set up**:
   - **App permissions:** **Read**.
   - **Type of App:** **Native App** (a public client: no client secret is needed or stored).
   - **Callback URI / Redirect URL:** exactly `http://127.0.0.1:4747/oauth/x/callback`. If you changed `HUB_PORT` in `.env`, use that port instead of `4747`. It must match character for character: `127.0.0.1`, not `localhost`, and no trailing slash.
   - **Website URL:** any URL you own, for example your X profile `https://x.com/<you>`.
   - **Save.**
4. **Keys and tokens → OAuth 2.0 Client ID and Client Secret:** copy the **Client ID**. Ignore any client secret; streamhub does not use one.
5. **Request Livestream API access** for this app with X's [Livestream API Access Form](https://docs.x.com/forms/livestream-api-access). X's docs say the whole Livestream API, broadcasts included, is limited to whitelisted apps and reviewed by X. You can connect before X approves the app; the X row then shows the "Livestream API access" error until approval comes through.

## Connect
Dashboard → **Settings** (gear button or ⌘,) → **Platforms** → X → paste the Client ID → **Save client** → **Connect** → **Continue to X sign-in**.
- Approve streamhub's request to read your account, posts and broadcasts (`broadcast.read tweet.read users.read offline.access`).
- The tab says "X is connected", and the row shows `@yourname`.
- Finish the sign-in within about 10 minutes of pressing Connect. If X says the link expired, press **Connect** again.

## What the X status means
| Shown | Meaning |
| :- | :- |
| `x: live` | Your newest X broadcast is running. Viewer count and title come from X. |
| `x: offline` · "Broadcast not started yet" | A broadcast exists but has not been published yet. |
| `x: offline` · "No live broadcast right now" | No broadcast, or the newest one has ended. |
| `x: error` · "Livestream API access" | X refused to list your broadcasts for this app. See below. |
| `x: error` on the X row in Settings | The sign-in expired or was revoked. Press **Connect** again. |

**Ingest** (whether X is receiving your video) shows **unknown** unless X has granted your app access to the Livestream API's stream sources. That endpoint is allowlist-only. streamhub tries it once per connection and stops asking when X refuses.

## Good to know
- **Livestream API access:** while X has not approved your app (step 5), streamhub retries every 10 minutes and picks up the approval on its own.
- **Cost:** reading your own data is billed at about $0.001 per resource, and the same resource is billed once per 24 hours. streamhub checks every 15 seconds while a broadcast is scheduled or running and every 30 seconds otherwise, reading at most 5 broadcasts each time.
- **Rate limits:** if X answers "rate limit reached", streamhub waits until X's reset time (at least a minute) and tries again.
- **Privacy:** your client ID and tokens live only in `.streamhub/secrets.json` on this computer. Never commit or share them.
