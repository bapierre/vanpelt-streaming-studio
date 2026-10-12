# Connect Twitch

streamhub reads your chat with Twitch's EventSub and signs you in with a device code. No password or client secret is stored. The app ID and the Twitch tokens are stored only in `.streamhub/secrets.json` on this computer (an owner-only file).

## One-time: register a Twitch app (2 minutes)
1. Go to https://dev.twitch.tv/console (2FA must be enabled on your Twitch account) → **Register Your Application**.
2. Name: anything unique, e.g. `streamhub-<yourname>`. OAuth Redirect URL: `http://localhost` (required by the form, not used). Category: **Application Integration**.
3. **Client Type: Public.** This lets streamhub sign in without a secret.
4. Create, then copy the **Client ID** and paste it in the dashboard: **Settings → Twitch → Client ID → Save and connect**. No restart is needed.

Each person or fork registers their own app; Twitch asks apps not to share client IDs.

You can also put the Client ID in `.env` as `TWITCH_CLIENT_ID`. The dashboard is the better place: an ID pasted there is saved to disk, wins over `.env`, and applies at once. `.env` only sets the default for a first run, like `OBS_WS_URL`.

## Connect
Dashboard → **Settings** (the Settings tab, or ⌘,) → **Twitch** → **Save and connect**. Open the link, enter the code shown, and approve. The card turns **connected** with your login.

streamhub asks to read your chat, your followers and your subscriptions. The last two are for alerts and goals ([docs/alerts.md](../alerts.md)); if you connected before alerts existed, press **Connect** again to allow them.

streamhub re-checks the login every hour, as Twitch requires. If the login expires or you revoke access, the Twitch card shows the error; press **Connect** again.

Saving a different Client ID drops the old sign-in (its tokens belong to the previous app), so connect again after changing it.
