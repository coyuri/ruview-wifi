/**
 * vroid-hub.js — VRoid Hub OAuth2 integration
 *
 * フロー:
 *   1. login()          → VRoid Hub 認証ページへリダイレクト
 *   2. Rust server      → /vroid/callback でコード→トークン交換（client_secret使用）
 *   3. handleCallback() → URL の ?vroid_token= を検出してセッションに保存
 *   4. fetchCatalog()   → 自分のモデル + お気に入りを取得
 */

const VROID_CLIENT_ID = 'WwL9s-Ni_emkmEWYTNGvvIvWBJJ62x0-yJNAcH_JqbE';
const VROID_API       = 'https://hub.vroid.com/api';
const VROID_AUTH_URL  = 'https://hub.vroid.com/oauth/authorize';

/** サーバーサイドコールバックURI（Rust sensing server の /vroid/callback） */
function _callbackUri() {
  return `${location.protocol}//${location.host}/vroid/callback`;
}

// ── OAuth flow ────────────────────────────────────────────────────

export function login() {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     VROID_CLIENT_ID,
    redirect_uri:  _callbackUri(),
    scope:         'default',
  });
  location.href = `${VROID_AUTH_URL}?${params}`;
}

/**
 * Rust server が /vroid/callback でトークン交換後、
 * /ui/skeleton3d.html?vroid_token=xxx にリダイレクトしてくる。
 * その ?vroid_token= をセッションに保存して URL をクリーンアップ。
 * @returns {boolean} トークンを受け取った場合 true
 */
export function handleCallback() {
  const params = new URLSearchParams(location.search);
  const token  = params.get('vroid_token');
  if (!token) return false;

  sessionStorage.setItem('vroid_token', token);
  history.replaceState({}, '', location.pathname);
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
