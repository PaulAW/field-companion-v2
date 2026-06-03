/* auth.js — Google Sign-In + session management */

var Auth = (() => {
  const BACKEND = 'https://field-companion-backend.paulwiner5.workers.dev';
  const TOKEN_KEY = 'fc_session_token';
  const USER_KEY  = 'fc_user';

  let _token = localStorage.getItem(TOKEN_KEY) || null;
  let _user  = (() => { try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch(e) { return null; } })();

  /* ── Public getters ── */
  function getToken()     { return _token; }
  function getUser()      { return _user; }
  function isSignedIn()   { return !!_token && !!_user; }

  /* ── Sign in via Google ID token ── */
  async function signInWithToken(idToken) {
    const res = await fetch(BACKEND + '/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: idToken }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Sign-in failed');
    }
    const data = await res.json();
    _token = data.token;
    _user  = { email: data.email, name: data.name };
    localStorage.setItem(TOKEN_KEY, _token);
    localStorage.setItem(USER_KEY, JSON.stringify(_user));
    return _user;
  }

  /* ── Sign out ── */
  async function signOut() {
    if (_token) {
      try {
        await fetch(BACKEND + '/auth/signout', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + _token },
        });
      } catch(e) { /* best effort */ }
    }
    _token = null;
    _user  = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }

  /* ── Verify session with server (call on app start) ── */
  async function verifySession() {
    if (!_token) return false;
    try {
      const res = await fetch(BACKEND + '/auth/me', {
        headers: { Authorization: 'Bearer ' + _token },
      });
      if (!res.ok) {
        // session invalid/expired — clear local state
        _token = null; _user = null;
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        return false;
      }
      const data = await res.json();
      _user = { email: data.email, name: data.name };
      localStorage.setItem(USER_KEY, JSON.stringify(_user));
      return true;
    } catch(e) {
      // Network error — assume token still valid (offline tolerance)
      return !!_token;
    }
  }

  /* ── Google Identity Services callback ── */
  function handleCredentialResponse(response) {
    signInWithToken(response.credential)
      .then(user => {
        App.toast('Signed in as ' + user.name + ' ✓');
        // Update settings panel UI
        renderAuthUI();
        // Full sync now that we're signed in (observations + boundaries)
        if (window.Sync) Sync.fullSync();
      })
      .catch(e => {
        if (e.message === 'Access denied') {
          App.toast('⛔ This app is private. Only the registered account can sign in.', 5000);
        } else {
          App.toast('Sign-in error: ' + e.message);
        }
      });
  }

  /* ── Render auth section inside settings panel ── */
  function renderAuthUI() {
    const el = document.getElementById('auth-section');
    if (!el) return;

    if (isSignedIn()) {
      el.innerHTML = `
        <div class="lbl">Cloud Sync</div>
        <div class="alert alert-ok" style="margin-bottom:8px">
          ✓ Signed in as <strong>${esc(_user.name || _user.email)}</strong>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn-sm btn-outline" id="sync-now-btn">🔄 Sync now</button>
          <button class="btn btn-sm btn-outline" id="sign-out-btn">Sign out</button>
        </div>
        <div id="sync-status-msg" style="font-size:11px;color:var(--muted);margin-top:6px"></div>`;

      document.getElementById('sign-out-btn').addEventListener('click', async () => {
        await signOut();
        renderAuthUI();
        App.toast('Signed out');
      });

      document.getElementById('sync-now-btn').addEventListener('click', () => {
        if (window.Sync) Sync.fullSync();
      });
    } else {
      el.innerHTML = `
        <div class="lbl">Cloud Sync</div>
        <p style="font-size:12px;color:var(--muted);margin:0 0 8px">Sign in to sync observations across devices.</p>
        <div id="google-signin-btn"></div>`;

      // Render Google Sign-In button — always shows account chooser
      setTimeout(() => {
        if (window.google && google.accounts) {
          google.accounts.id.renderButton(
            document.getElementById('google-signin-btn'),
            { theme: 'outline', size: 'medium', text: 'sign_in_with', width: 240 }
          );
          // Cancel any pending One Tap so the button is the only sign-in path
          google.accounts.id.cancel();
        }
      }, 100);
    }
  }

  /* ── Init: wire up Google Identity Services ── */
  function init() {
    // Initialize Google Identity Services when the library is ready
    function tryInit() {
      if (window.google && google.accounts) {
        google.accounts.id.initialize({
          client_id: '298580141763-qm4ud9gcrulad44oclbn7c2sgjadde1i.apps.googleusercontent.com',
          callback: handleCredentialResponse,
          auto_select: false,   // never silently sign in — user must click the button
        });
      } else {
        setTimeout(tryInit, 200);
      }
    }
    tryInit();
  }

  function esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { init, isSignedIn, getToken, getUser, signOut, verifySession, renderAuthUI, handleCredentialResponse };
})();
