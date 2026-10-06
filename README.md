# Discord Auth for Owncast (v0.3.0+)

Viewers must log in with Discord. Chat uses their Discord display name, and the chat avatar is replaced with their Discord profile picture.

## 1. Create the Discord app
1. https://discord.com/developers/applications -> New Application.
2. OAuth2 -> copy the **Client ID** and **Client Secret**.
3. OAuth2 -> Redirects -> add exactly:
   `https://YOUR-OWNCAST-DOMAIN/plugins/discord-auth/callback`
   (Owncast should be served over HTTPS.)

## 2. Build the package
The SDK's build tooling produces the `.ocpkg`. Scaffold a project, then copy these files over it:

    npx create-owncast-plugin@latest discord-auth
    # copy plugin.manifest.json, src/plugin.js and assets/client.js over the scaffold
    # (keep the scaffold's package.json / build config)
    npm run build && npm run package    # check the scaffold's package.json for exact script names

## 3. Install
Owncast admin -> Plugins -> Upload Plugin -> pick `discord-auth.ocpkg`, review the permissions, then
fill in the config form (Client ID, Client Secret, Public URL) **before** toggling Enable.
Enabling arms the gate: the whole site then requires Discord login. Admin pages stay reachable
with your normal admin password, so you can always disable it.

## Notes / limitations
- Display name is seeded the first time someone logs in. Owncast doesn't update it if they later rename on Discord.
  The avatar does refresh on each login.
- Avatar swap is client-side (Owncast has no plugin API for avatar URLs). Selectors in `assets/client.js`
  are guesses at Owncast's markup and may need tweaking.
- Only one auth.gate plugin can be enabled at a time.
- Only the `identify` scope is requested (no email, no servers).

## Known issue: chat still uses an anonymous identity
The login, the registered user and the session all work. But with Owncast 0.3.0's stock web client, chat
ends up on a separate anonymous user the page creates right after login, and the "Require Authentication"
chat setting shows "Authenticate to chat". Tracked upstream: https://github.com/owncast/owncast/issues/5202

### Reproducing / diagnosing
`/plugins/discord-auth/whoami` returns the identity Owncast resolves for a request. To see the registered
user before the viewer page loads, log in via:

    https://YOUR-DOMAIN/plugins/discord-auth/start?return_to=/plugins/discord-auth/whoami

The same page afterwards (once the viewer page has loaded) resolves to the anonymous user instead.
