import { handle } from '../src/lib/core.js';
import assert from 'node:assert/strict';

const kvStore = new Map();
const kv = { get: async k => kvStore.has(k) ? kvStore.get(k) : null, put: async (k, v) => { kvStore.set(k, v) }, delete: async k => { kvStore.delete(k) } };
const env = { PROGRAMMING: kv, ADMIN_TOKEN: 'adm_test_123456', MEMBERSTACK_SECRET_KEY: 'sk_live', MEMBERSTACK_TEST_SECRET_KEY: 'sk_sb_test',
  MEMBERSTACK_APP_ID: 'app_x', AFFILIATE_PLAN_IDS: 'pln_aff', ALLOWED_ORIGINS: 'https://www.trainsentinel.com' };

// fake Memberstack: tokens map to members; test-mode members only verify with the sandbox key
const members = {
  tok_active: { key: 'sk_live', m: { id: 'mem_1', planConnections: [{ planId: 'pln_aff', status: 'ACTIVE' }] } },
  tok_due:    { key: 'sk_live', m: { id: 'mem_2', planConnections: [{ planId: 'pln_aff', status: 'PAST_DUE' }] } },
  tok_cancel: { key: 'sk_live', m: { id: 'mem_3', planConnections: [{ planId: 'pln_aff', status: 'CANCELED' }] } },
  tok_other:  { key: 'sk_live', m: { id: 'mem_4', planConnections: [{ planId: 'pln_other', status: 'ACTIVE' }] } },
  tok_test:   { key: 'sk_sb_test', m: { id: 'mem_5', planConnections: [{ planId: 'pln_aff', status: 'TRIALING' }] } },
};
const byId = Object.fromEntries(Object.values(members).map(x => [x.m.id, x]));
let calls = 0;
const fakeFetch = async (url, opt = {}) => {
  calls++;
  const key = (opt.headers || {})['x-api-key'];
  if (url.endsWith('/members/verify-token')) {
    const t = JSON.parse(opt.body).token, rec = members[t];
    if (!rec || rec.key !== key) return new Response('{}', { status: 401 });
    return Response.json({ data: { id: rec.m.id, type: 'member', aud: 'app_x', exp: Date.now() / 1000 + 3600 } });
  }
  const id = decodeURIComponent(url.split('/members/')[1]), rec = byId[id];
  if (!rec || rec.key !== key) return new Response('{}', { status: 404 });
  return Response.json({ data: rec.m });
};
const B = 'https://www.trainsentinel.com/portal-api';
const req = (path, { method = 'GET', token, body, origin } = {}) => new Request(B + path, {
  method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(origin ? { origin } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined });
const call = async (p, o) => { const r = await handle(req(p, o), env, fakeFetch); let j = null; try { j = await r.clone().json() } catch {} return { s: r.status, j, h: r.headers }; };

let r;
// admin protection
r = await call('/api/admin/week/1/draft', { method: 'PUT', body: { html: '<p>x</p>' } }); assert.equal(r.s, 401);
r = await call('/api/admin/week/1/draft', { method: 'PUT', token: 'wrong', body: { html: '<p>x</p>' } }); assert.equal(r.s, 401);
r = await call('/api/admin/week/1/draft', { method: 'PUT', token: env.ADMIN_TOKEN, body: { html: '<p>x</p><script>alert(1)</script>' } }); assert.equal(r.s, 400);
r = await call('/api/admin/week/1/draft', { method: 'PUT', token: env.ADMIN_TOKEN, body: { html: '<img src=x onerror=alert(1)>' } }); assert.equal(r.s, 400);
// upload a draft: not visible to members until published
r = await call('/api/admin/week/1/draft', { method: 'PUT', token: env.ADMIN_TOKEN, body: { title: 'Week 1', dates: 'Dec 28 – Jan 2', days: ['2026-12-28'], html: '<div class="m-day">W1</div>' } });
assert.equal(r.s, 200); assert.equal(r.j.saved, 'draft');
r = await call('/api/weeks', { token: 'tok_active' }); assert.equal(r.s, 200); assert.deepEqual(r.j.weeks, []);
r = await call('/api/week/1', { token: 'tok_active' }); assert.equal(r.s, 404);
// publish
r = await call('/api/admin/week/1/publish', { method: 'POST', token: env.ADMIN_TOKEN }); assert.equal(r.s, 200);
// member checks
r = await call('/api/week/1'); assert.equal(r.s, 401, 'logged out');
r = await call('/api/week/1', { token: 'garbage' }); assert.equal(r.s, 401, 'bad token');
r = await call('/api/week/1', { token: 'tok_cancel' }); assert.equal(r.s, 403, 'cancelled');
r = await call('/api/week/1', { token: 'tok_other' }); assert.equal(r.s, 403, 'other plan');
r = await call('/api/week/1', { token: 'tok_active' }); assert.equal(r.s, 200); assert.match(r.j.html, /W1/);
assert.equal(r.h.get('cache-control'), 'private, no-store, max-age=0');
r = await call('/api/weeks', { token: 'tok_due' }); assert.equal(r.s, 200); assert.equal(r.j.pastDue, true); assert.equal(r.j.weeks[0].n, 1);
r = await call('/api/week/1', { token: 'tok_test' }); assert.equal(r.s, 200, 'test-mode member via sandbox key');
// unpublish
r = await call('/api/admin/week/1/unpublish', { method: 'POST', token: env.ADMIN_TOKEN }); assert.equal(r.s, 200);
r = await call('/api/week/1', { token: 'tok_active' }); assert.equal(r.s, 404);
// CORS only for allowed origins
r = await call('/api/weeks', { token: 'tok_active', origin: 'https://evil.example' }); assert.equal(r.h.get('access-control-allow-origin'), null);
r = await call('/api/weeks', { token: 'tok_active', origin: 'https://www.trainsentinel.com' }); assert.equal(r.h.get('access-control-allow-origin'), 'https://www.trainsentinel.com');
// members can't write
r = await call('/api/week/1', { method: 'POST', token: 'tok_active' }); assert.equal(r.s, 405);
r = await call('/api/admin/weeks', { token: 'tok_active' }); assert.equal(r.s, 401);
console.log('all tests passed');
