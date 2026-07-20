'use strict';
/**
 * 증분 파이프라인 HTTP 래퍼 — n8n(셸 실행 노드 없음)이 httpRequest로 run_periodic을 부르게 함.
 * 파이프라인 호스트에서 상시 실행. 로직은 전부 run_periodic.sh에 있고 여기선 호출만.
 *
 *   GET  /health                         → {ok, running}
 *   GET  /periodic/status[?track=]       → 최신 summary.json 디제스트(들)   (토큰 필요)
 *   POST /periodic/run {track, apply}    → run_periodic.sh 실행             (토큰 필요)
 *       detect/recruit(감지) 등은 동기 응답(디제스트), apply=true(장기)는 202 즉시 응답 후 백그라운드.
 *
 * 인증: 헤더 X-Pipe-Token == env PIPELINE_TOKEN. (apply는 반드시 토큰 게이트 — n8n만 호출)
 * 완료 통지(선택): env N8N_DONE_WEBHOOK(http) 설정 시 apply 완료 후 디제스트를 POST.
 */
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

const ALIO = '/workspace/alio';
const PORT = Number(process.env.PIPELINE_PORT || 8092);
const TOKEN = (process.env.PIPELINE_TOKEN || '').trim();
const DONE_HOOK = (process.env.N8N_DONE_WEBHOOK || '').trim();  // http 웹훅(선택)
const TRACKS = ['detect', 'recruit', 'monthly', 'quarterly', 'annual'];
let running = null;   // {track, apply, since}

const digest = t => { try { return JSON.parse(fs.readFileSync(`${ALIO}/_ops/logs/periodic_${t}.summary.json`, 'utf8')); } catch { return null; } };
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json' }); res.end(b); };
const authed = req => TOKEN && (req.headers['x-pipe-token'] || '') === TOKEN;

function postDone(out) {
  if (!DONE_HOOK) return;
  try {
    const u = new URL(DONE_HOOK), body = JSON.stringify(out);
    const r = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, () => {});
    r.on('error', () => {}); r.write(body); r.end();
  } catch {}
}

function runTrack(track, apply) {
  return new Promise(resolve => {
    running = { track, apply, since: new Date().toISOString() };
    const args = [`${ALIO}/1_collection/run_periodic.sh`, track];
    if (apply) args.push('--apply');
    const p = spawn('bash', args, { cwd: ALIO, env: process.env });
    let tail = '';
    const cap = d => { tail = (tail + d).slice(-2000); };
    p.stdout.on('data', cap); p.stderr.on('data', cap);
    p.on('close', code => {
      running = null;
      const out = { ok: code === 0, exit: code, track, apply, digest: digest(track), tail: tail.slice(-800) };
      if (apply) postDone(out);
      resolve(out);
    });
    p.on('error', e => { running = null; resolve({ ok: false, error: e.message, track, apply }); });
  });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/health') return send(res, 200, { ok: true, running });
  if (!authed(req)) return send(res, 401, { ok: false, error: 'unauthorized' });

  if (req.method === 'GET' && u.pathname === '/periodic/status') {
    const t = u.searchParams.get('track');
    if (t) return send(res, 200, { track: t, digest: digest(t) });
    const all = {}; for (const tk of TRACKS) { const d = digest(tk); if (d) all[tk] = d; }
    return send(res, 200, all);
  }

  if (req.method === 'POST' && u.pathname === '/periodic/run') {
    let body = ''; req.on('data', c => body += c); await new Promise(r => req.on('end', r));
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
    const track = j.track, apply = !!j.apply;
    if (!TRACKS.includes(track)) return send(res, 400, { ok: false, error: 'track must be one of ' + TRACKS.join('|') });
    if (running) return send(res, 409, { ok: false, error: 'busy', running });
    if (apply) { runTrack(track, true); return send(res, 202, { ok: true, started: true, track, apply: true }); }
    const out = await runTrack(track, false);   // 감지류는 빠르니 동기 응답
    return send(res, 200, out);
  }

  send(res, 404, { ok: false, error: 'not found' });
}).listen(PORT, () => console.log(`[periodic_server] listening :${PORT} (auth ${TOKEN ? 'on' : 'OFF!!'})`));
