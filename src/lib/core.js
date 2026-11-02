// Sentinel programming server.
// Members: the programming is returned only after Memberstack confirms, on the server,
// that the visitor is logged in and has an active Affiliate plan.
// Admin: new weeks are uploaded as drafts and go live only through a separate publish call.

const MS_API = 'https://admin.memberstack.com';
const OK_STATUS = new Set(['ACTIVE', 'TRIALING', 'PAST_DUE']);
const MAX_HTML = 900_000; // KV values can be far larger; this keeps uploads sane

// ---------- helpers ----------
function headersFor(origin, env) {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Vary': 'Origin',
  };
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Max-Age'] = '600';
  }
  return h;
}
const json = (status, body, h) => new Response(JSON.stringify(body), { status, headers: h });

function bearer(req) {
  const a = req.headers.get('authorization') || '';
  return a.startsWith('Bearer ') ? a.slice(7).trim() : '';
}

// constant-time compare so the admin key can't be guessed by timing
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0 && x.length > 0;
}

// ---------- membership check (server-side) ----------
async function verifyWithKey(token, key, env, fetchImpl) {
  const v = await fetchImpl(`${MS_API}/members/verify-token`, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!v.ok) return null;
  const t = (await v.json()).data || {};
  if (!t.id || t.type !== 'member') return null;
  if (env.MEMBERSTACK_APP_ID && t.aud && t.aud !== env.MEMBERSTACK_APP_ID) return null;
  if (t.exp && t.exp * 1000 < Date.now()) return null;
  const m = await fetchImpl(`${MS_API}/members/${encodeURIComponent(t.id)}`, { headers: { 'x-api-key': key } });
  if (!m.ok) return null;
  return (await m.json()).data || null;
}

export async function checkMember(token, env, fetchImpl = fetch) {
  if (!token || token.length > 4096) return { ok: false, code: 401 };
  // live key first; the test-mode key (used by the staging address) only if it's configured
  const keys = [env.MEMBERSTACK_SECRET_KEY, env.MEMBERSTACK_TEST_SECRET_KEY].filter(Boolean);
  let member = null;
  for (const k of keys) {
    try { member = await verifyWithKey(token, k, env, fetchImpl); } catch { member = null; }
    if (member) break;
  }
  if (!member) return { ok: false, code: 401 };
  const plans = String(env.AFFILIATE_PLAN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const pc = (member.planConnections || []).filter(p =>
    plans.includes(p.planId) && OK_STATUS.has(String(p.status || '').toUpperCase()));
  if (!pc.length) return { ok: false, code: 403 };
  return { ok: true, memberId: member.id, pastDue: pc.every(p => String(p.status).toUpperCase() === 'PAST_DUE') };
}

// ---------- storage ----------
// KV keys:  index:live  -> [{n,title,dates,days}]   week:N:live / week:N:draft -> {n,title,dates,days,html,updatedAt}
async function getJSON(kv, key) { const v = await kv.get(key); return v ? JSON.parse(v) : null; }
async function liveIndex(kv) { return (await getJSON(kv, 'index:live')) || []; }
async function writeIndex(kv, list) {
  list.sort((a, b) => a.n - b.n);
  await kv.put('index:live', JSON.stringify(list));
}
const meta = w => ({ n: w.n, title: w.title, dates: w.dates, days: w.days || [] });

function validWeek(n) { return Number.isInteger(n) && n >= 1 && n <= 520; }

// ---------- router ----------
export async function handle(req, env, fetchImpl = fetch) {
  const url = new URL(req.url);
  const h = headersFor(req.headers.get('origin'), env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const kv = env.PROGRAMMING;
  if (!kv) return json(500, { error: 'storage-missing' }, h);

  // path after the mount path, e.g. /api/weeks
  const p = url.pathname.replace(/\/+$/, '');
  const m = p.match(/\/api\/(.*)$/);
  const route = m ? m[1] : '';

  // ----- admin -----
  if (route.startsWith('admin/')) {
    if (!env.ADMIN_TOKEN || !safeEqual(bearer(req), env.ADMIN_TOKEN)) return json(401, { error: 'unauthorized' }, h);
    const r = route.slice(6);
    if (req.method === 'GET' && r === 'weeks') {
      const live = await liveIndex(kv);
      const drafts = (await getJSON(kv, 'index:drafts')) || [];
      return json(200, { live, drafts }, h);
    }
    const wm = r.match(/^week\/(\d+)\/(draft|publish|unpublish)$/);
    if (!wm) return json(404, { error: 'not-found' }, h);
    const n = Number(wm[1]), act = wm[2];
    if (!validWeek(n)) return json(400, { error: 'bad-week' }, h);

    if (act === 'draft' && req.method === 'PUT') {
      let b; try { b = await req.json(); } catch { return json(400, { error: 'bad-json' }, h); }
      if (typeof b.html !== 'string' || !b.html || b.html.length > MAX_HTML) return json(400, { error: 'bad-html' }, h);
      if (/<script[\s>]/i.test(b.html) || /\son\w+\s*=/i.test(b.html) || /javascript:/i.test(b.html))
        return json(400, { error: 'scripts-not-allowed' }, h);
      const w = { n, title: String(b.title || `Week ${n}`).slice(0, 120), dates: String(b.dates || '').slice(0, 160),
        days: Array.isArray(b.days) ? b.days.slice(0, 7).map(String) : [], html: b.html, updatedAt: new Date().toISOString() };
      await kv.put(`week:${n}:draft`, JSON.stringify(w));
      const di = ((await getJSON(kv, 'index:drafts')) || []).filter(x => x.n !== n);
      di.push({ ...meta(w), updatedAt: w.updatedAt }); di.sort((a, b) => a.n - b.n);
      await kv.put('index:drafts', JSON.stringify(di));
      return json(200, { saved: 'draft', ...meta(w), chars: w.html.length }, h);
    }
    if (act === 'draft' && req.method === 'GET') {
      const d = await getJSON(kv, `week:${n}:draft`);
      return d ? json(200, d, h) : json(404, { error: 'no-draft' }, h);
    }
    if (act === 'publish' && req.method === 'POST') {
      const d = await getJSON(kv, `week:${n}:draft`);
      if (!d) return json(404, { error: 'no-draft' }, h);
      const live = { ...d, publishedAt: new Date().toISOString() };
      await kv.put(`week:${n}:live`, JSON.stringify(live));
      const idx = (await liveIndex(kv)).filter(w => w.n !== n); idx.push(meta(live)); await writeIndex(kv, idx);
      return json(200, { published: n }, h);
    }
    if (act === 'unpublish' && req.method === 'POST') {
      await kv.delete(`week:${n}:live`);
      await writeIndex(kv, (await liveIndex(kv)).filter(w => w.n !== n));
      return json(200, { unpublished: n }, h);
    }
    return json(405, { error: 'method' }, h);
  }

  // ----- members -----
  if (req.method !== 'GET') return json(405, { error: 'method' }, h);
  if (route !== 'weeks' && !/^week\/\d+$/.test(route)) return json(404, { error: 'not-found' }, h);
  const who = await checkMember(bearer(req), env, fetchImpl);
  if (!who.ok) return json(who.code, { error: who.code === 401 ? 'login-required' : 'plan-inactive' }, h);

  if (route === 'weeks') return json(200, { weeks: await liveIndex(kv), pastDue: who.pastDue }, h);
  const n = Number(route.split('/')[1]);
  if (!validWeek(n)) return json(400, { error: 'bad-week' }, h);
  const w = await getJSON(kv, `week:${n}:live`);
  if (!w) return json(404, { error: 'not-published' }, h);
  return json(200, { ...meta(w), html: w.html }, h);
}
