'use strict';

/**
 * /api/impose 接口层测试：双面生产标记的开关、校验、导出结构与正背坐标变换。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app } = require('../server');

const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
const FIT = { paperWidth: 472, paperHeight: 342, pageWidth: 210, pageHeight: 297, bleedMm: 3, safetyMm: 5 };

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

test('未启用：响应 productionMarks = { enabled: false }，纸张对象无标记字段', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, BASE);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.productionMarks, { enabled: false });
    assert.equal(res.body.signatures[0].sheets[0].productionMarks, undefined);
  } finally {
    await srv.close();
  }
});

test('启用标记且余量充足：导出 JSON 含正 / 背面线段坐标、汇总计数', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, ...FIT, productionMarks: true });
    assert.equal(res.status, 200);
    const pm = res.body.productionMarks;
    assert.equal(pm.enabled, true);
    assert.equal(pm.markLengthMm, 5);
    assert.equal(pm.markGapMm, 3);
    assert.equal(pm.paperWidth, 472);
    assert.equal(pm.paperHeight, 342);
    assert.equal(pm.totalMarks, 20);
    assert.equal(pm.placedMarks, 20);
    assert.equal(pm.omittedMarks, 0);
    assert.equal(pm.sheetCount, 2);

    const sheet = res.body.signatures[0].sheets[0].productionMarks;
    assert.equal(sheet.placedCount, 10);
    assert.deepEqual(sheet.omitted, []);
    // 每个标记带 id / 类型 / 名称 / 候选序号 / 线段坐标
    sheet.front.forEach((m) => {
      assert.ok(['crop', 'fold', 'register'].includes(m.type));
      assert.ok(m.id);
      assert.ok(m.name);
      assert.equal(Number.isInteger(m.candidateIndex), true);
      assert.ok(Array.isArray(m.segments) && m.segments.length > 0);
      m.segments.forEach((s) => ['x1', 'y1', 'x2', 'y2'].forEach((k) => assert.equal(typeof s[k], 'number')));
    });
    // 背面标记数量、身份与正面一一对应，坐标为短边翻转结果
    assert.equal(sheet.back.length, sheet.front.length);
    sheet.front.forEach((f, i) => {
      const b = sheet.back[i];
      assert.equal(b.id, f.id);
      f.segments.forEach((fs, k) => {
        assert.equal(b.segments[k].x1, 472 - fs.x1);
        assert.equal(b.segments[k].x2, 472 - fs.x2);
        assert.equal(b.segments[k].y1, fs.y1);
      });
    });
  } finally {
    await srv.close();
  }
});

test('无可用位置：标记省略并在导出 JSON 中给出原因（含逐候选失败）', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE,
      paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, bleedMm: 3,
      productionMarks: true,
    });
    assert.equal(res.status, 200);
    const sheet = res.body.signatures[0].sheets[0].productionMarks;
    assert.ok(sheet.omittedCount >= 8);
    sheet.omitted.forEach((o) => {
      assert.ok(o.id);
      assert.ok(o.reason);
      assert.ok(['out-of-paper', 'bleed-overlap', 'mark-overlap'].includes(o.reasonCode));
      assert.equal(o.failures.length, o.candidatesTried);
      o.failures.forEach((f) => {
        assert.equal(Number.isInteger(f.candidateIndex), true);
        assert.ok(['out-of-paper', 'bleed-overlap', 'mark-overlap'].includes(f.code));
        assert.ok(f.message);
      });
    });
  } finally {
    await srv.close();
  }
});

test('非法请求返回 400：未启用适配检查 / 尺寸非法 / 开关非布尔', async () => {
  const srv = await startServer();
  try {
    const noFit = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, productionMarks: true });
    assert.equal(noFit.status, 400);
    assert.match(noFit.body.error, /必须先启用适配检查/);

    const badBool = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, ...FIT, productionMarks: 1 });
    assert.equal(badBool.status, 400);
    assert.match(badBool.body.error, /布尔值/);

    const badSize = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, ...FIT, productionMarks: true, markLengthMm: -1 });
    assert.equal(badSize.status, 400);
    assert.match(badSize.body.error, /标记长度/);
  } finally {
    await srv.close();
  }
});

test('标记尺寸参数随请求生效，核验重算不受生产标记影响', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE, ...FIT, productionMarks: true, markLengthMm: 4, markGapMm: 2,
      observations: [
        { signature: 1, sheet: 1, side: 'front', position: 'left', page: 8, orientation: 'upright' },
        { signature: 1, sheet: 1, side: 'back', position: 'left', page: 2, orientation: 'upright' },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.productionMarks.markLengthMm, 4);
    assert.equal(res.body.productionMarks.markGapMm, 2);
    assert.equal(res.body.verification.conclusion.status, 'verified');
  } finally {
    await srv.close();
  }
});
