# Connect Twitch

streamhub reads your chat with Twitch's EventSub and signs you in with a device code. No password or client secret is stored. The Twitch tokens are stored only in `.streamhub/secrets.json` on this computer (an owner-only file).

## One-time: register a Twitch app (2 minutes)
1. Go to https://dev.twitch.tv/console (2FA must be enabled on your Twitch account) → **Register Your Application**.
2. Name: anything unique, e.g. `streamhub-<yourname>`. OAuth Redirect URL: `http://localhost` (required by the form, not used). Category: **Application Integration**.
3. **Client Type: Public.** This lets streamhub sign in without a secret.
4. Create, then copy the **Client ID** into `.env`:
   ```
   TWITCH_CLIENT_ID=your_client_id
   ```
5. Restart streamhub.

Each person or fork registers their own app; Twitch asks apps not to share client IDs.

## Connect
Dashboard → **Settings** (gear button or ⌘,) → **Platforms** → Twitch → **Connect**. Open the link, enter the code shown, and approve. The row turns **connected** with your login.

streamhub re-checks the login every hour, as Twitch requires. If the login expires or you revoke access, the Twitch row shows the error; press **Connect** again.
