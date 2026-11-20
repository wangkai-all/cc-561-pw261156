'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server.js');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise(resolve => server.close(resolve)));

beforeEach(async () => {
  const res = await fetch(`${base}/api/reset`, { method: 'POST' });
  assert.equal(res.status, 200);
});

async function post(path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

function readingById(state, id) {
  return state.readings.find(r => r.id === id);
}

// ---------- 正常流程 ----------

test('正常：接收未经校验的读数后全部待校验（延迟交付，不提前判定）', async () => {
  const { status, body } = await post('/api/receive-sample');
  assert.equal(status, 201);
  assert.equal(body.added.length, 5);
  assert.ok(body.state.readings.every(r => r.status === 'pending'));
  assert.equal(body.state.counts.pending, 5);
  assert.equal(body.state.counts.qualified, 0);
});

test('正常：补交当班校验后按覆盖时段判定并绑定', async () => {
  await post('/api/receive-sample');
  const { status, body } = await post('/api/calibrations/sample');
  assert.equal(status, 201);
  const s = body.state;
  // 上午班 → 绑定 C-AM
  assert.equal(readingById(s, 'R-1001').status, 'qualified');
  assert.equal(readingById(s, 'R-1001').boundCalibrationId, 'C-AM');
  assert.equal(readingById(s, 'R-1002').status, 'out_of_tolerance');
  assert.equal(readingById(s, 'R-1003').status, 'instrument_incomplete');
  // 下午班 → 绑定 C-PM
  assert.equal(readingById(s, 'R-1004').status, 'qualified');
  assert.equal(readingById(s, 'R-1004').boundCalibrationId, 'C-PM');
  // 18:10 不在任何校验时段内 → 继续延迟交付
  assert.equal(readingById(s, 'R-1005').status, 'pending');
  assert.equal(readingById(s, 'R-1005').boundCalibrationId, null);
});

test('正常：仪表缺件与工件真超差分开标记', async () => {
  await post('/api/calibrations/sample');
  // 仪表齐全且超差 → 工件真超差
  const a = await post('/api/readings', {
    id: 'R-2001', workpieceId: 'WP-2001', deviceVersion: 'MIC-V2.3',
    value: 10.09, instrumentComplete: true, measuredAt: '2026-11-20T09:30:00',
  });
  assert.equal(a.status, 201);
  assert.equal(a.body.reading.status, 'out_of_tolerance');
  // 同样超差的数值但仪表缺件 → 不算工件超差
  const b = await post('/api/readings', {
    id: 'R-2002', workpieceId: 'WP-2002', deviceVersion: 'MIC-V2.3',
    value: 10.09, instrumentComplete: false, measuredAt: '2026-11-20T09:31:00',
  });
  assert.equal(b.status, 201);
  assert.equal(b.body.reading.status, 'instrument_incomplete');
});

test('正常：撤回校验只冲正绑定到它的项目', async () => {
  await post('/api/receive-sample');
  await post('/api/calibrations/sample');
  const { status, body } = await post('/api/calibrations/C-AM/withdraw');
  assert.equal(status, 200);
  const s = body.state;
  // 绑定 C-AM 的三条被冲正，且保留冲正前状态
  for (const id of ['R-1001', 'R-1002', 'R-1003']) {
    assert.equal(readingById(s, id).status, 'affected');
  }
  assert.equal(readingById(s, 'R-1001').previousStatus, 'qualified');
  assert.equal(readingById(s, 'R-1002').previousStatus, 'out_of_tolerance');
  assert.equal(readingById(s, 'R-1003').previousStatus, 'instrument_incomplete');
  // 绑定 C-PM 的不受影响
  assert.equal(readingById(s, 'R-1004').status, 'qualified');
  // 从未被覆盖的仍待校验
  assert.equal(readingById(s, 'R-1005').status, 'pending');
  // 受影响工件清单
  const aff = await get('/api/affected');
  assert.equal(aff.status, 200);
  assert.deepEqual(aff.body.affected.map(a => a.workpieceId).sort(), ['WP-1001', 'WP-1002', 'WP-1003']);
});

test('正常：撤回后补交新校验可重新判定（冲正恢复）', async () => {
  await post('/api/receive-sample');
  await post('/api/calibrations/sample');
  await post('/api/calibrations/C-AM/withdraw');
  const { status, body } = await post('/api/calibrations', {
    id: 'C-AM2', deviceVersion: 'MIC-V2.3', standard: 10.0, tolerance: 0.05,
    validFrom: '2026-11-20T08:00:00', validTo: '2026-11-20T12:00:00',
  });
  assert.equal(status, 201);
  const s = body.state;
  assert.equal(readingById(s, 'R-1001').status, 'qualified');
  assert.equal(readingById(s, 'R-1001').boundCalibrationId, 'C-AM2');
  assert.equal(readingById(s, 'R-1002').status, 'out_of_tolerance');
  assert.equal(readingById(s, 'R-1003').status, 'instrument_incomplete');
});

test('正常：校验先到时，读数接收即判定', async () => {
  await post('/api/calibrations/sample');
  const { status, body } = await post('/api/readings', {
    id: 'R-3001', workpieceId: 'WP-3001', deviceVersion: 'MIC-V2.3',
    value: 10.01, instrumentComplete: true, measuredAt: '2026-11-20T14:00:00',
  });
  assert.equal(status, 201);
  assert.equal(body.reading.status, 'qualified');
  assert.equal(body.reading.boundCalibrationId, 'C-PM');
});

// ---------- 异常流程 ----------

test('异常：重复接收同一批读数返回 409', async () => {
  await post('/api/receive-sample');
  const again = await post('/api/receive-sample');
  assert.equal(again.status, 409);
  assert.match(again.body.error, /已存在/);
});

test('异常：缺字段或非法值的读数返回 400', async () => {
  const missing = await post('/api/readings', {
    id: 'R-X', deviceVersion: 'MIC-V2.3', value: 10.0, measuredAt: '2026-11-20T09:00:00',
  });
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /workpieceId/);
  const badValue = await post('/api/readings', {
    id: 'R-Y', workpieceId: 'WP-Y', deviceVersion: 'MIC-V2.3',
    value: 'abc', measuredAt: '2026-11-20T09:00:00',
  });
  assert.equal(badValue.status, 400);
  const dup = await post('/api/readings', {
    id: 'R-Y2', workpieceId: 'WP-Y2', deviceVersion: 'MIC-V2.3',
    value: 10.0, measuredAt: '2026-11-20T09:00:00',
  });
  assert.equal(dup.status, 201);
  const dupAgain = await post('/api/readings', {
    id: 'R-Y2', workpieceId: 'WP-Y2', deviceVersion: 'MIC-V2.3',
    value: 10.0, measuredAt: '2026-11-20T09:00:00',
  });
  assert.equal(dupAgain.status, 409);
});

test('异常：撤回不存在或已撤回的校验', async () => {
  const notFound = await post('/api/calibrations/NOPE/withdraw');
  assert.equal(notFound.status, 404);
  await post('/api/calibrations/sample');
  await post('/api/calibrations/C-AM/withdraw');
  const twice = await post('/api/calibrations/C-AM/withdraw');
  assert.equal(twice.status, 409);
});

test('异常：未知设备版本没有匹配校验，读数保持待校验不被误判', async () => {
  await post('/api/calibrations/sample');
  const { status, body } = await post('/api/readings', {
    id: 'R-Z', workpieceId: 'WP-Z', deviceVersion: 'OTHER-V9',
    value: 10.0, instrumentComplete: true, measuredAt: '2026-11-20T09:00:00',
  });
  assert.equal(status, 201);
  assert.equal(body.reading.status, 'pending');
  assert.equal(body.reading.boundCalibrationId, null);
});

// ---------- 页面 ----------

test('页面：业务结果区带 data-evidence-result，三个操作按钮齐全', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /data-evidence-result/);
  assert.ok(html.includes('接收未经校验的读数'));
  assert.ok(html.includes('补交后撤回检定'));
  assert.ok(html.includes('查看受影响工件'));
});
