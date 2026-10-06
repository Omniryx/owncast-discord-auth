const { definePlugin, owncast } = require('@owncast/plugin-sdk');

const SLUG = 'discord-auth';
const DISCORD_API = 'https://discord.com/api';
const STATE_TTL_MS = 10 * 60 * 1000;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Only allow same-origin paths so the callback can't be used as an open redirect.
function safeReturnTo(v) {
  if (typeof v !== 'string' || v[0] !== '/' || v[1] === '/' || v[1] === '\\') return '/';
  return v;
}

function randomToken() {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    // Fallback if the sandbox has no crypto. Weaker, so prefer an SDK-provided RNG if one exists.
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function form(obj) {
  return Object.keys(obj).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(obj[k])).join('&');
}

function redirectUri() {
  const base = String(owncast.config.get('publicUrl', '')).replace(/\/+$/, '');
  return base + '/plugins/' + SLUG + '/callback';
}

function avatarUrl(user) {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return 'https://cdn.discordapp.com/avatars/' + user.id + '/' + user.avatar + '.' + ext + '?size=64';
  }
  let idx = 0;
  try {
    idx = Number((BigInt(user.id) >> 22n) % 6n);
  } catch (e) {
    idx = 0;
  }
  return 'https://cdn.discordapp.com/embed/avatars/' + idx + '.png';
}

function ensureSchema() {
  owncast.sql.exec(`CREATE TABLE IF NOT EXISTS discord_users (
    owncast_user_id TEXT PRIMARY KEY,
    discord_id      TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    avatar_url      TEXT NOT NULL,
    updated_at      INTEGER NOT NULL
  )`);
}

function page(title, bodyHtml) {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body:
      '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(title) + '</title><style>' +
      'body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}' +
      '.card{background:#1c1c22;padding:2rem 2.5rem;border-radius:12px;text-align:center;max-width:380px}' +
      'a.btn{display:inline-block;margin-top:1rem;background:#5865f2;color:#fff;text-decoration:none;padding:.75rem 1.5rem;border-radius:8px;font-weight:600}' +
      'p{color:#aaa}</style></head><body><div class="card">' + bodyHtml + '</div></body></html>',
  };
}

function loginPage(returnTo, error) {
  const serverName = 'this stream';
  return page(
    'Sign in',
    '<h2>Sign in to watch</h2>' +
      (error ? '<p style="color:#f66">' + esc(error) + '</p>' : '<p>Log in with Discord to join ' + serverName + ' and chat.</p>') +
      '<a class="btn" href="/plugins/' + SLUG + '/start?return_to=' + encodeURIComponent(returnTo) + '">Login with Discord</a>',
  );
}

module.exports = definePlugin({
  onHttpRequest(req) {
    const query = req.query || {};
    const path = req.path;

    if (req.method === 'GET' && path === '/') {
      return loginPage(safeReturnTo(query.return_to));
    }

    if (path === '/start') {
      const clientId = owncast.config.get('clientId', '');
      const base = owncast.config.get('publicUrl', '');
      if (!clientId || !base) {
        return page('Not configured', '<h2>Discord login not configured</h2><p>The server admin needs to set the Client ID and public URL.</p>');
      }
      const state = randomToken();
      owncast.kv.setJSON('state:' + state, { returnTo: safeReturnTo(query.return_to), at: Date.now() });
      const url =
        'https://discord.com/oauth2/authorize?' +
        form({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: redirectUri(),
          scope: 'identify',
          state: state,
          prompt: 'none',
        });
      return { status: 302, headers: { Location: url } };
    }

    if (path === '/callback') {
      if (query.error) {
        return loginPage('/', 'Discord login was cancelled.');
      }
      const saved = owncast.kv.getJSON('state:' + (query.state || ''), null);
      // One-time use: clear it either way.
      if (query.state) owncast.kv.set('state:' + query.state, '');
      if (!saved || Date.now() - saved.at > STATE_TTL_MS || !query.code) {
        return loginPage('/', 'Login expired or invalid. Please try again.');
      }

      const tokenRes = owncast.http.fetch(DISCORD_API + '/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({
          client_id: owncast.config.get('clientId', ''),
          client_secret: owncast.config.get('clientSecret', ''),
          grant_type: 'authorization_code',
          code: query.code,
          redirect_uri: redirectUri(),
        }),
      });
      if (tokenRes.status !== 200) {
        owncast.log.warning('discord token exchange failed: ' + tokenRes.status);
        return loginPage(saved.returnTo, 'Discord rejected the login. Please try again.');
      }
      const accessToken = JSON.parse(tokenRes.body).access_token;

      const meRes = owncast.http.fetch(DISCORD_API + '/users/@me', {
        headers: { authorization: 'Bearer ' + accessToken },
      });
      if (meRes.status !== 200) {
        owncast.log.warning('discord /users/@me failed: ' + meRes.status);
        return loginPage(saved.returnTo, 'Could not read your Discord profile.');
      }
      const me = JSON.parse(meRes.body);
      const name = me.global_name || me.username;
      const avatar = avatarUrl(me);

      const { userId } = owncast.users.register({
        authId: 'discord:' + me.id,
        displayName: name,
        handle: me.username,
        profileUrl: 'https://discord.com/users/' + me.id,
        public: false,
      });

      ensureSchema();
      owncast.sql.exec(
        `INSERT INTO discord_users (owncast_user_id, discord_id, display_name, avatar_url, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owncast_user_id) DO UPDATE SET
           display_name = excluded.display_name,
           avatar_url = excluded.avatar_url,
           updated_at = excluded.updated_at`,
        [String(userId), String(me.id), String(name), avatar, Date.now()],
      );

      const hours = Number(owncast.config.get('sessionHours', 168)) || 168;
      owncast.auth.grantSession({ userId, ttl: Math.round(hours * 3600) });
      return { status: 302, headers: { Location: saved.returnTo } };
    }

    // name -> avatar map used by assets/client.js to swap avatars in chat.
    if (path === '/avatars.json') {
      ensureSchema();
      const rows = owncast.sql.query(
        'SELECT display_name, avatar_url FROM discord_users ORDER BY updated_at DESC LIMIT 5000',
      );
      const map = {};
      rows.forEach((r) => {
        map[r.display_name] = r.avatar_url;
      });
      return {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=30' },
        body: JSON.stringify(map),
      };
    }

    // Diagnostic: shows which identity Owncast resolves for a request to this plugin.
    // Only ever returns the caller's own info.
    if (path === '/whoami') {
      return {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({ user: req.user || null, authenticated: !!req.authenticated }, null, 2),
      };
    }

    if (path === '/logout') {
      owncast.auth.endSession();
      return { status: 302, headers: { Location: '/' } };
    }

    return { status: 404, body: 'not found' };
  },
});
