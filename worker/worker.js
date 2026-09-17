/**
 * 班主任智慧工作台 · 自建云同步后端
 * Cloudflare Worker + Workers KV，单文件、零依赖。
 *
 * 接口：
 *   POST /api/ping   鉴权自检                -> { ok, count }
 *   POST /api/pull   { known:{k:ts} }        -> { ok, count, map:{k:body}, ts:{k:ms} }
 *   POST /api/push   { items:[{key,body,ts,dev}] } -> { ok, okKeys, stale, failed }
 *   POST /api/wipe   {}                      -> { ok, deleted }
 *   POST /api/img    { data:base64, contentType }  -> { ok, url }
 *   GET  /api/img/:id                         -> 图片二进制（凭不可猜的 id，不再校验口令）
 *
 * 需要绑定的环境变量：
 *   WB_KEY  同步口令（务必设为「加密」变量；不设置则服务一律拒绝，绝不敞开）
 *   WB_NS   命名空间前缀，可选，默认 'wb'
 * 需要绑定的 KV：
 *   WB      KV 命名空间
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-wb-key',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-max-age': '86400',
};

const MAX_ITEMS = 500;
const MAX_BODY = 8 * 1024 * 1024;
const MAX_KEY_LEN = 300;
const MAX_IMG = 10 * 1024 * 1024;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign(
      {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
      CORS
    ),
  });
}

function raw(body, status, headers) {
  return new Response(body, {
    status: status || 200,
    headers: Object.assign({}, headers || {}, CORS),
  });
}

/** 口令比对：定长异或，避免按字符提前返回 */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!a.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function auth(request, env) {
  if (!env || !env.WB_KEY) return false;
  const given = request.headers.get('x-wb-key') || '';
  return sameSecret(given, env.WB_KEY);
}

function ns(env) {
  const p = (env && env.WB_NS) || 'wb';
  return 'shard:' + String(p).replace(/[^A-Za-z0-9_-]/g, '') + ':';
}

function imgNs(env) {
  const p = (env && env.WB_NS) || 'wb';
  return 'img:' + String(p).replace(/[^A-Za-z0-9_-]/g, '') + ':';
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function listAll(kv, prefix) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 50; i++) {
    const r = await kv.list({ prefix: prefix, limit: 1000, cursor: cursor || undefined });
    if (r && r.keys) out.push.apply(out, r.keys);
    if (!r || r.list_complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return out;
}

async function onPull(request, env) {
  const prefix = ns(env);
  const keys = await listAll(env.WB, prefix);
  let known = {};
  try {
    const body = await request.json();
    if (body && body.known && typeof body.known === 'object') known = body.known;
  } catch (e) {}

  const map = {};
  const ts = {};
  const changed = [];
  for (const k of keys) {
    const full = k.name;
    const short = full.slice(prefix.length);
    const mts = (k.metadata && k.metadata.ts) || 0;
    ts[short] = mts;
    const have = known[short] || 0;
    if (mts > have) changed.push({ short: short, full: full });
  }
  // 只回传客户端还没有的正文，省流量
  const bodies = await Promise.all(changed.map((c) => env.WB.get(c.full)));
  changed.forEach((c, i) => {
    const v = bodies[i];
    if (typeof v === 'string') map[c.short] = v;
  });

  return json({ ok: true, count: keys.length, map: map, ts: ts });
}

async function onPush(request, env) {
  let items = [];
  try {
    const body = await request.json();
    items = (body && body.items) || [];
  } catch (e) {
    return json({ ok: false, error: 'bad-json' }, 400);
  }
  if (!Array.isArray(items) || !items.length) return json({ ok: true, okKeys: [], stale: [], failed: [] });
  if (items.length > MAX_ITEMS) return json({ ok: false, error: 'too-many-items' }, 413);

  const prefix = ns(env);
  const okKeys = [];
  const stale = [];
  const failed = [];
  const writes = [];

  for (const it of items) {
    const key = it && it.key;
    const bodyText = it && it.body;
    if (typeof key !== 'string' || !key || key.length > MAX_KEY_LEN) {
      failed.push(String(key || ''));
      continue;
    }
    if (typeof bodyText !== 'string' || bodyText.length > MAX_BODY) {
      failed.push(key);
      continue;
    }
    const inTs = Date.parse(it.ts) || Date.now();
    writes.push({ key: key, body: bodyText, ts: inTs, dev: String(it.dev || '').slice(0, 40) });
  }

  // 逐条比时间戳，服务端更新的分片不接受覆盖
  for (const w of writes) {
    const full = prefix + w.key;
    let curTs = 0;
    try {
      const cur = await env.WB.getWithMetadata(full);
      curTs = (cur && cur.metadata && cur.metadata.ts) || 0;
    } catch (e) {
      curTs = 0;
    }
    if (curTs > w.ts) {
      stale.push(w.key);
      continue;
    }
    try {
      await env.WB.put(full, w.body, { metadata: { ts: w.ts, dev: w.dev } });
      okKeys.push(w.key);
    } catch (e) {
      failed.push(w.key);
    }
  }

  return json({ ok: true, okKeys: okKeys, stale: stale, failed: failed });
}

async function onWipe(env) {
  const prefix = ns(env);
  const keys = await listAll(env.WB, prefix);
  const names = keys.map((k) => k.name);
  let deleted = 0;
  for (let i = 0; i < names.length; i += 500) {
    const chunk = names.slice(i, i + 500);
    try {
      await env.WB.delete(chunk);
      deleted += chunk.length;
    } catch (e) {
      for (const n of chunk) {
        try {
          await env.WB.delete(n);
          deleted++;
        } catch (e2) {}
      }
    }
  }
  return json({ ok: true, deleted: deleted });
}

async function onImgUpload(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'bad-json' }, 400);
  }
  const b64 = body && body.data;
  if (typeof b64 !== 'string' || !b64) return json({ ok: false, error: 'no-data' }, 400);

  let ct = String((body && body.contentType) || 'image/jpeg').toLowerCase();
  if (!/^image\/(png|jpeg|jpg|gif|webp|bmp|svg\+xml|heic|heif|tiff)$/.test(ct)) ct = 'image/jpeg';
  if (ct === 'image/jpg') ct = 'image/jpeg';

  const bytes = b64ToBytes(b64);
  if (bytes.length > MAX_IMG) return json({ ok: false, error: 'too-large' }, 413);

  const id = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
  try {
    await env.WB.put(imgNs(env) + id, bytes, { metadata: { ct: ct, size: bytes.length } });
  } catch (e) {
    return json({ ok: false, error: 'put-failed' }, 500);
  }
  const origin = new URL(request.url).origin;
  return json({ ok: true, url: origin + '/api/img/' + id, size: bytes.length });
}

async function onImgGet(env, id) {
  if (!/^[a-f0-9]{24,64}$/.test(id)) return json({ ok: false, error: 'bad-id' }, 400);
  const r = await env.WB.getWithMetadata(imgNs(env) + id, { type: 'arrayBuffer' });
  if (!r || !r.value) return json({ ok: false, error: 'not-found' }, 404);
  const ct = (r.metadata && r.metadata.ct) || 'image/jpeg';
  return raw(r.value, 200, {
    'content-type': ct,
    'cache-control': 'public, max-age=31536000, immutable',
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') return raw(null, 204, {});

    if (!env || !env.WB) {
      return json({ ok: false, error: 'kv-not-bound', hint: '请给 Worker 绑定名为 WB 的 KV 命名空间' }, 500);
    }
    if (!env.WB_KEY) {
      return json({ ok: false, error: 'key-not-set', hint: '请给 Worker 设置名为 WB_KEY 的加密变量' }, 500);
    }

    // 图片读取不校验口令：<img src> 无法带请求头，靠不可猜的 40 位 id 做访问凭据
    if (path.indexOf('/api/img/') === 0 && request.method === 'GET') {
      return onImgGet(env, path.slice('/api/img/'.length));
    }

    if (request.method !== 'POST') {
      return json({ ok: false, error: 'method-not-allowed' }, 405);
    }

    if (!auth(request, env)) {
      return json({ ok: false, error: 'bad-key' }, 401);
    }

    try {
      if (path === '/api/ping') {
        const keys = await listAll(env.WB, ns(env));
        const imgs = await listAll(env.WB, imgNs(env));
        return json({ ok: true, count: keys.length, images: imgs.length, ns: (env.WB_NS || 'wb') });
      }
      if (path === '/api/pull') return onPull(request, env);
      if (path === '/api/push') return onPush(request, env);
      if (path === '/api/wipe') return onWipe(env);
      if (path === '/api/img') return onImgUpload(request, env);
    } catch (e) {
      return json({ ok: false, error: 'server-error', detail: String((e && e.message) || e) }, 500);
    }

    return json({ ok: false, error: 'not-found', path: path }, 404);
  },
};
