'use strict';

/*
 * 检定记录「延迟交付 + 撤回冲正」本地演示服务（仅用 Node.js 内置模块，不接外部服务）
 *
 * 业务规则：
 *  - 上传端先发测量结果（带工件号、设备版本），接收队列一律先挂「待校验」；
 *  - 判定服务只在存在「同设备版本且覆盖测量时段」的有效参考校验时才放行判定（延迟交付）；
 *  - 判定结果三分：仪表缺件 → instrument_incomplete（读数无效，不算工件问题）；
 *                  偏差 ≤ 允差 → qualified（合格）；否则 → out_of_tolerance（工件真超差）；
 *  - 校验被撤回时，仅绑定到该校验的记录被冲正为「受撤回影响」，其余记录不变；
 *  - 被冲正的记录在补交新校验后自动重新判定。
 *
 * 启动：node server.js（读取 PORT，默认 3000，绑定 127.0.0.1）
 */

const http = require('node:http');

const DEVICE_VERSION = 'MIC-V2.3';
const SAMPLE_DAY = '2026-11-20';

const STATUS = {
  PENDING: 'pending',                             // 待校验（延迟交付中）
  QUALIFIED: 'qualified',                         // 合格
  OUT_OF_TOLERANCE: 'out_of_tolerance',           // 工件真超差
  INSTRUMENT_INCOMPLETE: 'instrument_incomplete', // 仪表缺件，读数无效
  AFFECTED: 'affected',                           // 受校验撤回影响（已冲正）
};

function createState() {
  return { readings: [], calibrations: [], events: [] };
}

let state = createState();

function httpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function logEvent(type, detail) {
  state.events.push({ at: new Date().toISOString(), type, detail });
}

// ---------- 本地样例 ----------

function sampleReadings() {
  return [
    // 上午班（将被 C-AM 覆盖）
    { id: 'R-1001', workpieceId: 'WP-1001', deviceVersion: DEVICE_VERSION, value: 10.02, instrumentComplete: true, measuredAt: SAMPLE_DAY + 'T09:15:00' },
    { id: 'R-1002', workpieceId: 'WP-1002', deviceVersion: DEVICE_VERSION, value: 10.08, instrumentComplete: true, measuredAt: SAMPLE_DAY + 'T09:40:00' },
    { id: 'R-1003', workpieceId: 'WP-1003', deviceVersion: DEVICE_VERSION, value: 10.09, instrumentComplete: false, measuredAt: SAMPLE_DAY + 'T10:05:00' },
    // 下午班（将被 C-PM 覆盖）
    { id: 'R-1004', workpieceId: 'WP-1004', deviceVersion: DEVICE_VERSION, value: 10.03, instrumentComplete: true, measuredAt: SAMPLE_DAY + 'T14:20:00' },
    // 18:10 不在任何校验时段内（始终无人覆盖）
    { id: 'R-1005', workpieceId: 'WP-1005', deviceVersion: DEVICE_VERSION, value: 9.995, instrumentComplete: true, measuredAt: SAMPLE_DAY + 'T18:10:00' },
  ];
}

function sampleCalibrations() {
  return [
    { id: 'C-AM', deviceVersion: DEVICE_VERSION, standard: 10.0, tolerance: 0.05, validFrom: SAMPLE_DAY + 'T08:00:00', validTo: SAMPLE_DAY + 'T12:00:00' },
    { id: 'C-PM', deviceVersion: DEVICE_VERSION, standard: 10.0, tolerance: 0.05, validFrom: SAMPLE_DAY + 'T13:00:00', validTo: SAMPLE_DAY + 'T17:00:00' },
  ];
}

// ---------- 判定服务 ----------

// 找覆盖该读数测量时段的有效校验（同设备版本、未撤回；多份时取最新提交的）
function findCoveringCalibration(reading) {
  const t = reading.measuredAt;
  const candidates = state.calibrations
    .filter(c => !c.withdrawn && c.deviceVersion === reading.deviceVersion && c.validFrom <= t && t <= c.validTo)
    .sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
  return candidates[0] || null;
}

// 单条判定：先分仪表缺件，再分合格 / 真超差
function judgeWith(reading, calibration) {
  if (!reading.instrumentComplete) return STATUS.INSTRUMENT_INCOMPLETE;
  const deviation = Math.abs(reading.value - calibration.standard);
  return deviation <= calibration.tolerance ? STATUS.QUALIFIED : STATUS.OUT_OF_TOLERANCE;
}

// 判定轮次：只处理 pending / affected，找不到覆盖校验就继续等（延迟交付）
function runJudgmentPass() {
  let judged = 0;
  for (const r of state.readings) {
    if (r.status !== STATUS.PENDING && r.status !== STATUS.AFFECTED) continue;
    const cal = findCoveringCalibration(r);
    if (!cal) continue;
    r.status = judgeWith(r, cal);
    r.boundCalibrationId = cal.id;
    r.judgedAt = new Date().toISOString();
    judged += 1;
  }
  return judged;
}

// ---------- 接收队列 / 参考校验 ----------

function addReading(input) {
  for (const k of ['id', 'workpieceId', 'deviceVersion', 'measuredAt']) {
    if (!input[k]) throw httpError(400, '缺少字段: ' + k);
  }
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) {
    throw httpError(400, 'value 必须是有限数字');
  }
  if (state.readings.some(r => r.id === input.id)) {
    throw httpError(409, '读数 ' + input.id + ' 已存在');
  }
  const reading = {
    id: input.id,
    workpieceId: input.workpieceId,
    deviceVersion: input.deviceVersion,
    value: input.value,
    instrumentComplete: input.instrumentComplete !== false,
    measuredAt: input.measuredAt,
    receivedAt: new Date().toISOString(),
    status: STATUS.PENDING,
    boundCalibrationId: null,
    previousStatus: null,
    judgedAt: null,
  };
  state.readings.push(reading);
  runJudgmentPass(); // 若校验已先到则立即判定，否则保持 pending（延迟交付）
  return reading;
}

function addCalibration(input) {
  for (const k of ['id', 'deviceVersion', 'validFrom', 'validTo']) {
    if (!input[k]) throw httpError(400, '缺少字段: ' + k);
  }
  if (typeof input.standard !== 'number' || !Number.isFinite(input.standard)) {
    throw httpError(400, 'standard 必须是有限数字');
  }
  if (typeof input.tolerance !== 'number' || !Number.isFinite(input.tolerance) || input.tolerance < 0) {
    throw httpError(400, 'tolerance 必须是非负有限数字');
  }
  if (input.validFrom > input.validTo) throw httpError(400, 'validFrom 不能晚于 validTo');
  if (state.calibrations.some(c => c.id === input.id)) {
    throw httpError(409, '校验 ' + input.id + ' 已存在');
  }
  const cal = {
    id: input.id,
    deviceVersion: input.deviceVersion,
    standard: input.standard,
    tolerance: input.tolerance,
    validFrom: input.validFrom,
    validTo: input.validTo,
    withdrawn: false,
    submittedAt: new Date().toISOString(),
    withdrawnAt: null,
  };
  state.calibrations.push(cal);
  const judged = runJudgmentPass();
  logEvent('calibration-submitted', '补交校验 ' + cal.id + '（' + cal.deviceVersion + '，' + cal.validFrom + ' ~ ' + cal.validTo + '），新判定 ' + judged + ' 条');
  return cal;
}

// 撤回：只冲正绑定到该校验的记录
function withdrawCalibration(id) {
  const cal = state.calibrations.find(c => c.id === id);
  if (!cal) throw httpError(404, '校验 ' + id + ' 不存在');
  if (cal.withdrawn) throw httpError(409, '校验 ' + id + ' 已撤回，不能重复撤回');
  cal.withdrawn = true;
  cal.withdrawnAt = new Date().toISOString();
  const affected = [];
  for (const r of state.readings) {
    if (r.boundCalibrationId === id && r.status !== STATUS.PENDING && r.status !== STATUS.AFFECTED) {
      r.previousStatus = r.status;
      r.status = STATUS.AFFECTED;
      affected.push(r);
    }
  }
  logEvent('calibration-withdrawn', '撤回校验 ' + id + '，冲正 ' + affected.length + ' 条绑定记录');
  return { calibration: cal, affected };
}

// ---------- 视图 ----------

function publicReading(r) {
  return {
    id: r.id,
    workpieceId: r.workpieceId,
    deviceVersion: r.deviceVersion,
    value: r.value,
    instrumentComplete: r.instrumentComplete,
    measuredAt: r.measuredAt,
    receivedAt: r.receivedAt,
    status: r.status,
    boundCalibrationId: r.boundCalibrationId,
    previousStatus: r.previousStatus,
    judgedAt: r.judgedAt,
  };
}

function countByStatus() {
  const counts = { pending: 0, qualified: 0, out_of_tolerance: 0, instrument_incomplete: 0, affected: 0 };
  for (const r of state.readings) counts[r.status] = (counts[r.status] || 0) + 1;
  return counts;
}

function snapshot() {
  return {
    readings: state.readings.map(publicReading),
    calibrations: state.calibrations.map(c => Object.assign({}, c)),
    events: state.events.slice(),
    counts: countByStatus(),
  };
}

// ---------- 页面 ----------
// 注意：本模板字符串内不得出现反引号与 ${，前端脚本一律用字符串拼接。

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>检定记录 · 延迟交付与撤回冲正</title>
<style>
  body { font-family: system-ui, "PingFang SC", "Microsoft YaHei", sans-serif; margin: 2rem auto; max-width: 1080px; padding: 0 1rem; color: #1f2933; }
  h1 { font-size: 1.35rem; }
  h2 { font-size: 1.02rem; margin: 1.6rem 0 .4rem; }
  .muted { color: #64748b; font-size: .86rem; }
  .toolbar { margin: 1rem 0; }
  .toolbar button { margin: 0 .5rem .5rem 0; padding: .5rem .95rem; border: 1px solid #94a3b8; border-radius: 6px; background: #fff; cursor: pointer; font-size: .9rem; }
  .toolbar button:hover { background: #f1f5f9; }
  .toolbar button.primary { background: #0f766e; border-color: #0f766e; color: #fff; }
  .toolbar button.primary:hover { background: #115e59; }
  table { border-collapse: collapse; margin: .4rem 0 1rem; width: 100%; }
  th, td { border: 1px solid #cbd5e1; padding: .32rem .55rem; font-size: .84rem; text-align: left; }
  th { background: #f1f5f9; }
  .badge { display: inline-block; padding: .1rem .55rem; border-radius: 999px; font-size: .78rem; color: #fff; white-space: nowrap; }
  .st-pending { background: #64748b; }
  .st-qualified { background: #16a34a; }
  .st-out_of_tolerance { background: #dc2626; }
  .st-instrument_incomplete { background: #d97706; }
  .st-affected { background: #7c3aed; }
  #evidence { border: 2px solid #0f766e; border-radius: 8px; padding: .8rem 1rem; margin: 1rem 0; background: #f0fdfa; }
  #evidence .err { color: #b91c1c; }
  #log li { font-size: .8rem; color: #475569; }
</style>
</head>
<body>
<h1>检定接收 → 校验覆盖判定 → 撤回冲正（本地样例）</h1>
<p class="muted">
  上传端先发测量结果（带工件号、设备版本），当班参考校验后到；判定服务只在校验覆盖对应时段后放行（延迟交付）。
  校验被撤回时仅冲正绑定到它的项目；「仪表缺件」与「工件真超差」分开标记。
</p>
<div class="toolbar">
  <button id="btn-receive" class="primary">接收未经校验的读数</button>
  <button id="btn-calibrate" class="primary">补交后撤回检定</button>
  <button id="btn-affected" class="primary">查看受影响工件</button>
  <button id="btn-reset">重置</button>
</div>
<div id="evidence" data-evidence-result="{}">
  <strong>业务结果区</strong>
  <div id="evidence-body">尚未操作。建议顺序：接收未经校验的读数 → 补交后撤回检定 → 查看受影响工件。</div>
</div>
<h2>接收队列 / 判定状态</h2>
<div id="readings"><p class="muted">加载中…</p></div>
<h2>参考校验</h2>
<div id="calibrations"><p class="muted">加载中…</p></div>
<h2>事件日志</h2>
<ul id="log"></ul>
<script>
var STATUS_LABEL = {
  pending: '待校验(延迟交付)',
  qualified: '合格',
  out_of_tolerance: '工件超差',
  instrument_incomplete: '仪表缺件',
  affected: '受撤回影响'
};

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

function badge(st) {
  return '<span class="badge st-' + esc(st) + '">' + esc(STATUS_LABEL[st] || st) + '</span>';
}

function api(path, method, body) {
  return fetch(path, {
    method: method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function (res) {
    return res.json().then(function (data) {
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      return data;
    });
  });
}

function countsText(counts) {
  var parts = [];
  Object.keys(STATUS_LABEL).forEach(function (k) {
    if (counts[k]) parts.push(STATUS_LABEL[k] + ' ' + counts[k]);
  });
  return parts.length ? parts.join('，') : '无记录';
}

function stateSummary(stage, state) {
  return {
    stage: stage,
    counts: state.counts,
    items: state.readings.map(function (r) { return r.workpieceId + ':' + r.status; }).sort()
  };
}

function setEvidence(summary, html) {
  document.getElementById('evidence').setAttribute('data-evidence-result', JSON.stringify(summary));
  document.getElementById('evidence-body').innerHTML = html;
}

function showError(err) {
  setEvidence({ error: String((err && err.message) || err) },
    '<p class="err">操作失败：' + esc((err && err.message) || err) + '</p>');
}

function renderState(state) {
  var el = document.getElementById('readings');
  if (!state.readings.length) {
    el.innerHTML = '<p class="muted">接收队列为空。</p>';
  } else {
    var rows = state.readings.map(function (r) {
      return '<tr>' +
        '<td>' + esc(r.id) + '</td>' +
        '<td>' + esc(r.workpieceId) + '</td>' +
        '<td>' + esc(r.deviceVersion) + '</td>' +
        '<td>' + Number(r.value).toFixed(3) + '</td>' +
        '<td>' + (r.instrumentComplete ? '齐全' : '缺件') + '</td>' +
        '<td>' + esc(r.measuredAt) + '</td>' +
        '<td>' + badge(r.status) + '</td>' +
        '<td>' + esc(r.boundCalibrationId || '—') + '</td>' +
        '<td>' + (r.previousStatus ? esc(STATUS_LABEL[r.previousStatus] || r.previousStatus) : '—') + '</td>' +
        '</tr>';
    }).join('');
    el.innerHTML = '<table><thead><tr>' +
      '<th>记录号</th><th>工件号</th><th>设备版本</th><th>测量值</th><th>仪表</th><th>测量时间</th><th>判定状态</th><th>绑定校验</th><th>冲正前状态</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }
  var cel = document.getElementById('calibrations');
  if (!state.calibrations.length) {
    cel.innerHTML = '<p class="muted">尚无参考校验。</p>';
  } else {
    var crows = state.calibrations.map(function (c) {
      return '<tr><td>' + esc(c.id) + '</td><td>' + esc(c.deviceVersion) + '</td>' +
        '<td>' + esc(c.validFrom) + ' ~ ' + esc(c.validTo) + '</td>' +
        '<td>' + Number(c.standard).toFixed(3) + ' ± ' + Number(c.tolerance).toFixed(3) + '</td>' +
        '<td>' + (c.withdrawn ? '已撤回' : '有效') + '</td></tr>';
    }).join('');
    cel.innerHTML = '<table><thead><tr><th>校验号</th><th>设备版本</th><th>覆盖时段</th><th>标准值 ± 允差</th><th>状态</th></tr></thead><tbody>' + crows + '</tbody></table>';
  }
  document.getElementById('log').innerHTML = state.events.map(function (e) {
    return '<li>' + esc(e.at) + ' [' + esc(e.type) + '] ' + esc(e.detail) + '</li>';
  }).join('');
}

function refresh() {
  return api('/api/state').then(renderState);
}

document.getElementById('btn-receive').addEventListener('click', function () {
  api('/api/receive-sample', 'POST').then(function (data) {
    renderState(data.state);
    setEvidence(
      stateSummary('received-unverified', data.state),
      '<p><b>接收未经校验的读数：</b>已入接收队列 ' + data.added.length + ' 条。当班参考校验尚未到，全部保持「待校验」，延迟交付，不提前判定。</p>' +
      '<p>当前统计：' + countsText(data.state.counts) + '</p>'
    );
  }).catch(showError);
});

document.getElementById('btn-calibrate').addEventListener('click', function () {
  var judged;
  api('/api/calibrations/sample', 'POST').then(function (data) {
    judged = data.state;
    return api('/api/calibrations/C-AM/withdraw', 'POST');
  }).then(function (wd) {
    renderState(wd.state);
    setEvidence(
      stateSummary('calibrated-then-withdrawn', wd.state),
      '<p><b>第一步 · 补交当班校验 C-AM / C-PM：</b>' + countsText(judged.counts) + '。</p>' +
      '<p><b>第二步 · 撤回 C-AM：</b>' + countsText(wd.state.counts) +
      '。仅绑定 C-AM 的项目被冲正为「受撤回影响」，绑定 C-PM 的判定保持有效，从未被覆盖的仍待校验。</p>'
    );
  }).catch(showError);
});

document.getElementById('btn-affected').addEventListener('click', function () {
  Promise.all([api('/api/affected'), api('/api/state')]).then(function (arr) {
    var affected = arr[0].affected;
    var state = arr[1];
    renderState(state);
    var html;
    if (affected.length) {
      html = '<p><b>受影响工件 ' + affected.length + ' 个</b>（因校验被撤回而冲正，需等待新校验重新判定）：</p><ul>' +
        affected.map(function (a) {
          return '<li>' + esc(a.workpieceId) + '（记录 ' + esc(a.readingId) +
            '，冲正前：' + esc(STATUS_LABEL[a.previousStatus] || a.previousStatus || '—') +
            '，原绑定 ' + esc(a.boundCalibrationId || '—') + '）</li>';
        }).join('') + '</ul>';
    } else {
      html = '<p>当前没有受撤回影响的工件。</p>';
    }
    var summary = stateSummary('affected-list', state);
    summary.affectedWorkpieces = affected.map(function (a) { return a.workpieceId; }).sort();
    setEvidence(summary, html);
  }).catch(showError);
});

document.getElementById('btn-reset').addEventListener('click', function () {
  api('/api/reset', 'POST').then(refresh).then(function () {
    setEvidence({ stage: 'reset' }, '<p>已重置，可重新演示。</p>');
  }).catch(showError);
});

refresh().catch(showError);
</script>
</body>
</html>
`;

// ---------- HTTP ----------

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(httpError(413, '请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(httpError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE_HTML);
    return;
  }

  if (req.method === 'GET' && path === '/api/state') {
    sendJson(res, 200, snapshot());
    return;
  }

  if (req.method === 'POST' && path === '/api/reset') {
    state = createState();
    sendJson(res, 200, { ok: true });
    return;
  }

  // 上传端：接收未经校验的读数（本地样例一批）
  if (req.method === 'POST' && path === '/api/receive-sample') {
    const samples = sampleReadings();
    const dup = samples.find(s => state.readings.some(r => r.id === s.id));
    if (dup) throw httpError(409, '读数 ' + dup.id + ' 已存在，请先重置再重新演示');
    const added = samples.map(s => addReading(s));
    logEvent('readings-received', '接收 ' + added.length + ' 条未经校验的读数（延迟交付）');
    sendJson(res, 201, { added: added.map(publicReading), state: snapshot() });
    return;
  }

  // 上传端：接收单条读数
  if (req.method === 'POST' && path === '/api/readings') {
    const body = await readJsonBody(req);
    const reading = addReading(body);
    logEvent('reading-received', '接收读数 ' + reading.id + '（工件 ' + reading.workpieceId + '）');
    sendJson(res, 201, { reading: publicReading(reading), state: snapshot() });
    return;
  }

  // 上传端：补交当班参考校验（本地样例两份）
  if (req.method === 'POST' && path === '/api/calibrations/sample') {
    const samples = sampleCalibrations();
    const dup = samples.find(s => state.calibrations.some(c => c.id === s.id));
    if (dup) throw httpError(409, '校验 ' + dup.id + ' 已存在，请先重置再重新演示');
    const added = samples.map(s => addCalibration(s));
    sendJson(res, 201, { added: added.map(c => c.id), state: snapshot() });
    return;
  }

  // 上传端：补交单份参考校验
  if (req.method === 'POST' && path === '/api/calibrations') {
    const body = await readJsonBody(req);
    const cal = addCalibration(body);
    sendJson(res, 201, { calibration: cal, state: snapshot() });
    return;
  }

  // 撤回校验：只冲正绑定到它的项目
  const withdrawMatch = path.match(/^\/api\/calibrations\/([^/]+)\/withdraw$/);
  if (req.method === 'POST' && withdrawMatch) {
    const id = decodeURIComponent(withdrawMatch[1]);
    const { affected } = withdrawCalibration(id);
    sendJson(res, 200, {
      withdrawn: id,
      affected: affected.map(publicReading),
      state: snapshot(),
    });
    return;
  }

  // 查看受影响工件
  if (req.method === 'GET' && path === '/api/affected') {
    const affected = state.readings
      .filter(r => r.status === STATUS.AFFECTED)
      .map(r => ({
        readingId: r.id,
        workpieceId: r.workpieceId,
        deviceVersion: r.deviceVersion,
        measuredAt: r.measuredAt,
        previousStatus: r.previousStatus,
        boundCalibrationId: r.boundCalibrationId,
      }));
    sendJson(res, 200, { affected });
    return;
  }

  sendJson(res, 404, { error: '路径不存在: ' + path });
}

function createServer() {
  return http.createServer((req, res) => {
    handleRequest(req, res).catch(err => {
      sendJson(res, err.statusCode || 500, { error: err.message || '内部错误' });
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '127.0.0.1', () => {
    console.log('检定演示服务已启动: http://127.0.0.1:' + port);
    console.log('演示顺序：接收未经校验的读数 → 补交后撤回检定 → 查看受影响工件');
  });
}

module.exports = { createServer, STATUS };
