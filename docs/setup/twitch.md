# Connect Twitch

streamhub reads your chat with Twitch's EventSub and signs you in with a device code. No password or secret is stored in streamhub, and the token stays on this computer.

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
Dashboard → **Connections** → Twitch → **Connect**. Open the link, enter the code shown, and approve. The row turns **connected** with your login.

streamhub re-checks the login every hour, as Twitch requires. If it expires or you revoke access, the row says so; press **Connect** again.
