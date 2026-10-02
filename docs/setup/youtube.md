# Connect YouTube (bring your own Google project)

YouTube's API policy forbids open-source apps from shipping API credentials, and quota is counted per Google project. So you create your own free project once (about 5 minutes). That also gives you your own 10,000 units/day of quota.

## One-time: create your Google OAuth client
1. https://console.cloud.google.com → project picker → **New project** (e.g. `streamhub`).
2. **APIs & Services → Library** → search **YouTube Data API v3** → **Enable**.
3. **Google Auth Platform** (OAuth consent screen) → **Get started**. App name `streamhub`, your email as support and developer contact. Audience: **External**.
4. **Audience → Test users → Add users**: add the Google account that owns your YouTube channel.
5. **Clients → Create client** → Application type **Desktop app** → Create. Copy the **Client ID** and **Client secret**.

## Connect
Dashboard → **Connections** → YouTube → paste the Client ID and Client secret → **Save client** → **Connect** → **Continue to Google sign-in**.
- Google warns that the app isn't verified. It's your own app: choose **Continue**.
- Grant "View your YouTube account" (read-only).
- The tab says "YouTube is connected", and the row shows your channel name.

## Good to know
- **7-day sign-in limit:** while your consent screen is in **Testing**, Google expires the sign-in after 7 days, and streamhub shows the error on the YouTube row; press **Connect** again. To avoid it, set the app to **In production** (Audience → Publish app). You'll still see the "unverified" warning, but only you use it.
- **When you're not live,** the status bar shows `youtube: offline`, and streamhub checks for a broadcast once a minute (1 quota unit each).
- **Deleted messages:** YouTube no longer reports deletions, so a message removed by a moderator may stay in the dashboard.
- **Privacy:** your client secret and tokens live only in `.streamhub/secrets.json` on this computer. Never commit or share them. Chat is kept in memory, not saved.
