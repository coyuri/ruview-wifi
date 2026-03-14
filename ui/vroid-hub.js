/**
 * vroid-hub.js — VRoid Hub OAuth2 PKCE integration
 *
 * OAuth2 PKCE フロー（client_secret 不要）:
 *   1. login()        → VRoid Hub 認証ページへリダイレクト
 *   2. handleCallback() → URL の ?code= を検出してトークン取得
 *   3. fetchCatalog() → 自分のモデル + お気に入りを取得
 */

const VROID_CLIENT_ID   = 'WwL9s-Ni_emkmEWYTNGvvIvWBJJ62x0-yJNAcH_JqbE';
const VROID_API         = 'https://hub.vroid.com/api';
const VROID_AUTH_URL    = 'https://hub.vroid.com/oauth/authorize';
const VROID_TOKEN_URL   = 'https://hub.vroid.com/oauth/token';
const REDIRECT_URI      = `${location.origin}${location.pathname}`;

// ── PKCE helpers ──────────────────────────────────────────────────

function _b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function _genVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return _b64url(arr);
}

async function _challenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return _b64url(hash);
}

// ── OAuth flow ────────────────────────────────────────────────────

export async function login() {
  const verifier   = _genVerifier();
  const challenge  = await _challenge(verifier);
  sessionStorage.setItem('vroid_verifier', verifier);

  const params = new URLSearchParams({
    response_type:         'code',
    client_id:             VROID_CLIENT_ID,
    redirect_uri:          REDIRECT_URI,
    scope:                 'default',
    code_challenge:        challenge,
    code_challenge_method: 'S256',
  });
  location.href = `${VROID_AUTH_URL}?${params}`;
}

export async function handleCallback() {
  const params   = new URLSearchParams(location.search);
  const code     = params.get('code');
  const verifier = sessionStorage.getItem('vroid_verifier');
  if (!code || !verifier) return false;

  // clean up URL without reload
  history.replaceState({}, '', location.pathname);

  const res = await fetch(VROID_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
      client_id:     VROID_CLIENT_ID,
      code_verifier: verifier,
    }),
  });

  if (!res.ok) {
    console.error('VRoid token exchange failed', await res.text());
    sessionStorage.removeItem('vroid_verifier');
    return false;
  }

  const { access_token } = await res.json();
  sessionStorage.setItem('vroid_token', access_token);
  sessionStorage.removeItem('vroid_verifier');
  return true;
}

export function getToken() {
  return sessionStorage.getItem('vroid_token');
}

export function logout() {
  sessionStorage.removeItem('vroid_token');
}

// ── Catalog fetch ─────────────────────────────────────────────────

async function _get(path, token) {
  const res = await fetch(`${VROID_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`VRoid API ${path} → ${res.status}`);
  return res.json();
}

/**
 * 自分のモデル + お気に入りモデルを取得して重複除去
 * @returns {Array<{id, name, imageUrl, downloadUrl}>}
 */
export async function fetchCatalog() {
  const token = getToken();
  if (!token) throw new Error('Not authenticated');

  const [uploaded, hearts] = await Promise.allSettled([
    _get('/account/character_models', token),
    _get('/hearts', token),
  ]);

  const all = [];
  if (uploaded.status === 'fulfilled') {
    const items = uploaded.value?.character_models ?? uploaded.value ?? [];
    all.push(...items);
  }
  if (hearts.status === 'fulfilled') {
    const items = hearts.value?.character_models ?? hearts.value ?? [];
    all.push(...items);
  }

  // deduplicate by id
  const seen = new Set();
  return all.filter(m => {
    const id = m.id ?? m.character_model_id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(m => ({
    id:          m.id ?? m.character_model_id,
    name:        m.name ?? m.character_model?.name ?? 'Unnamed',
    imageUrl:    m.image?.square_url ?? m.portrait_image?.square_url ?? '',
    downloadUrl: m.character_model_file_url ?? m.download_url ?? null,
  }));
}
