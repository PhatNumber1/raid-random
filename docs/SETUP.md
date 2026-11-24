# Using your own Twitch app

Only needed if you want to run the code with your own Twitch developer app (free, about 5 minutes).

This gives you a **Client ID**, which tells Twitch which app is asking.

1. Turn on two-factor login in your Twitch security settings (Twitch requires it).
2. Go to https://dev.twitch.tv/console/apps and choose **Register Your Application**.
3. Fill in:
   - **Name**: anything unique. Don't use the word "Twitch" in it.
   - **OAuth Redirect URLs**: `http://localhost` (the form asks for one; we don't use it)
   - **Category**: Broadcaster Suite
   - **Client Type**: **Public**. This matters: "Public" apps need no secret, which is
     what makes it safe to share the code on GitHub.
4. Create it, open **Manage**, and copy the **Client ID**.
5. Paste it between the quotes after `twitchClientId` in `app/config.json` and save.

The Client ID is not a secret. If Twitch ever shows you a **Client Secret**, don't put it
anywhere in this project.

The Raid Random website only accepts sign-ins from the official Client ID. With your own, set
`networkUrl` in `app/config.json` to `""`. Raids then use the rules built into the app.
