'use strict';

/**
 * /api/impose 接口层测试：重点覆盖「无法判定」时的下一处观察建议
 * 在真实 HTTP 接口上的可用性、导出数据结构、无建议场景与兼容性。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app } = require('../server');

const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };

function obs(patch) {
  return { signature: 1, sheet: 1, side: 'front', position: 'left', page: 8, orientation: 'upright', ...patch };
}

/** 启动测试服务器（随机端口），返回 base URL 与关闭函数。 */
async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (err) {
            reject(err);
            return;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('GET /api/health 健康检查', async () => {
  const srv = await startServer();
  try {
    const res = await new Promise((resolve, reject) => {
      http.get(`${srv.baseUrl}/api/health`, (r) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(raw) }));
      }).on('error', reject);
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    await srv.close();
  }
});

test('无法判定：响应 verification.nextSuggestion 含定位、各候选预期值与结果分组', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, observations: [obs({})] });
    assert.equal(res.status, 200);
    const v = res.body.verification;
    assert.equal(v.enabled, true);
    assert.equal(v.conclusion.status, 'undetermined');
    const s = v.nextSuggestion;
    assert.ok(s, '并列最优时应返回建议');
    assert.equal(s.signature, 1);
    assert.equal(s.sheet, 1);
    assert.ok(['front', 'back'].includes(s.side));
    assert.ok(['left', 'right'].includes(s.position));
    assert.ok(Number.isInteger(s.groupCount) && s.groupCount >= 2);
    assert.ok(Number.isInteger(s.worstRemainingCandidates));
    assert.equal(s.candidates.length, v.conclusion.tied.length);
    s.candidates.forEach((c) => {
      assert.ok(['left', 'right'].includes(c.binding));
      assert.ok(['long', 'short'].includes(c.flip));
      assert.equal(typeof c.blank, 'boolean');
      if (c.blank) {
        assert.equal(c.page, null);
      } else {
        assert.ok(c.page >= 1 && c.page <= BASE.totalPages);
        assert.ok(['upright', 'rotated'].includes(c.orientation));
      }
    });
    assert.equal(s.outcomeGroups.length, s.groupCount);
    const groupedCombos = s.outcomeGroups.flatMap((g) => g.combinations).length;
    assert.equal(groupedCombos, v.conclusion.tied.length);
    // 定位真实存在于导出的拼版清单中
    const slot = res.body.signatures[s.signature - 1].sheets[s.sheet - 1][s.side][s.position];
    assert.ok(slot);
    assert.equal(typeof slot.blank, 'boolean');
  } finally {
    await srv.close();
  }
});

test('建议随观察增删自动重算：新增并列观察后建议同步刷新且不与已有观察重叠', async () => {
  const srv = await startServer();
  const input = { totalPages: 10, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
  try {
    // 观察第 2 帖第 2 张（全空白张）正面左页位为空白：四种组合零差异并列
    const first = await postJson(`${srv.baseUrl}/api/impose`, {
      ...input,
      observations: [
        { signature: 2, sheet: 2, side: 'front', position: 'left', page: null, orientation: 'rotated' },
      ],
    });
    assert.equal(first.status, 200);
    const v1 = first.body.verification;
    assert.equal(v1.conclusion.status, 'undetermined');
    assert.equal(v1.conclusion.tied.length, 4);
    const s1 = v1.nextSuggestion;
    assert.ok(s1);
    assert.equal(s1.worstRemainingCandidates, 1);
    assert.equal(s1.groupCount, 4);

    // 「增」：在同一全空白张再补一条空白观察（四种组合仍一致 -> 保持 4 路并列），
    // 服务端重算后建议必须仍可给出，且不与任何已观察页位重叠。
    const observations = [
      { signature: 2, sheet: 2, side: 'front', position: 'left', page: null, orientation: 'rotated' },
      { signature: 2, sheet: 2, side: 'front', position: 'right', page: null, orientation: 'rotated' },
    ];
    const second = await postJson(`${srv.baseUrl}/api/impose`, { ...input, observations });
    assert.equal(second.status, 200);
    const v2 = second.body.verification;
    assert.equal(v2.conclusion.tied.length, 4);
    const s2 = v2.nextSuggestion;
    assert.ok(s2, '仍有可区分页位时应继续给建议');
    const keys = new Set(observations.map((o) => `${o.signature}/${o.sheet}/${o.side}/${o.position}`));
    assert.ok(!keys.has(`${s2.signature}/${s2.sheet}/${s2.side}/${s2.position}`));
    // 「删」：去掉新增的观察后结果应与首次完全一致（无状态接口的同步刷新）
    const third = await postJson(`${srv.baseUrl}/api/impose`, {
      ...input,
      observations: [observations[0]],
    });
    assert.equal(third.status, 200);
    assert.deepEqual(third.body.verification.nextSuggestion, s1);
    // 建议页位的预期值与导出清单中该页位的当前设置结果一致
    const current = s2.candidates.find(
      (c) => c.binding === input.binding && c.flip === input.flip
    );
    const slot = second.body.signatures[s2.signature - 1].sheets[s2.sheet - 1][s2.side][s2.position];
    assert.equal(current.blank, slot.blank);
    assert.equal(current.page, slot.blank ? null : slot.page);
  } finally {
    await srv.close();
  }
});

test('无建议场景：1 页册子两种翻转无法区分时 nextSuggestion 为 null', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      totalPages: 1,
      sheetsPerSignature: 1,
      binding: 'left',
      flip: 'short',
      observations: [
        { signature: 1, sheet: 1, side: 'front', position: 'left', page: null, orientation: 'upright' },
        { signature: 1, sheet: 1, side: 'front', position: 'right', page: 1, orientation: 'upright' },
      ],
    });
    assert.equal(res.status, 200);
    const v = res.body.verification;
    assert.equal(v.conclusion.status, 'undetermined');
    assert.equal(v.nextSuggestion, null);
    assert.match(v.conclusion.message, /已无可以继续区分/);
  } finally {
    await srv.close();
  }
});

test('verified / failed 与无观察：nextSuggestion 不出 / 核验不启用（兼容性）', async () => {
  const srv = await startServer();
  try {
    const verified = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      observations: [
        obs({}),
        obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
      ],
    });
    assert.equal(verified.body.verification.conclusion.status, 'verified');
    assert.equal(verified.body.verification.nextSuggestion, null);

    const failed = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      observations: [
        obs({ side: 'back', position: 'left', page: 2, orientation: 'upright' }),
        obs({ side: 'back', position: 'right', page: 7, orientation: 'upright' }),
        obs({ side: 'front', position: 'left', page: 1, orientation: 'upright' }),
      ],
    });
    assert.equal(failed.body.verification.conclusion.status, 'failed');
    assert.equal(failed.body.verification.nextSuggestion, null);

    const noObs = await postJson(`${srv.baseUrl}/api/impose`, BASE);
    assert.deepEqual(noObs.body.verification, { enabled: false });

    const emptyObs = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, observations: [] });
    assert.deepEqual(emptyObs.body.verification, { enabled: false });
  } finally {
    await srv.close();
  }
});

test('非法请求仍返回 400（核验流程接入建议计算不影响错误处理）', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      observations: [obs({}), obs({ page: 1 })], // 同一页位重复观察
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /重复观察/);
  } finally {
    await srv.close();
  }
});
