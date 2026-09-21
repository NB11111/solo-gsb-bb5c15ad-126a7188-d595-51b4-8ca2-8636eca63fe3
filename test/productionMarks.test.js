'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');
const {
  placeOneSide,
  transformMarksToBack,
  segmentInPaper,
  segmentIntersectsRect,
  segmentsIntersect,
} = require('../src/productionMarks');

const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
const FIT = { paperWidth: 472, paperHeight: 342, pageWidth: 210, pageHeight: 297, bleedMm: 3, safetyMm: 5 };

function allSheets(r) {
  const sheets = [];
  r.signatures.forEach((sig) => sig.sheets.forEach((sheet) => sheets.push(sheet)));
  return sheets;
}

test('未启用：productionMarks.enabled=false，纸张对象不带 productionMarks 字段（向后兼容）', () => {
  const r = computeImposition(BASE);
  assert.deepEqual(r.productionMarks, { enabled: false });
  allSheets(r).forEach((sheet) => assert.equal(sheet.productionMarks, undefined));
});

test('启用但未做适配检查：返回明确错误（标记位置依赖出血框）', () => {
  assert.throws(() => computeImposition({ ...BASE, productionMarks: true }), /必须先启用适配检查/);
});

test('参数校验：开关必须为布尔值，长度 / 间隙必须 ≥ 0，启用时长度 > 0', () => {
  assert.throws(
    () => computeImposition({ ...BASE, ...FIT, productionMarks: 'yes' }),
    /开关必须为布尔值/
  );
  assert.throws(
    () => computeImposition({ ...BASE, ...FIT, productionMarks: true, markLengthMm: -1 }),
    /标记长度/
  );
  assert.throws(
    () => computeImposition({ ...BASE, ...FIT, productionMarks: true, markGapMm: 'x' }),
    /标记间隙/
  );
  assert.throws(
    () => computeImposition({ ...BASE, ...FIT, productionMarks: true, markLengthMm: 0 }),
    /标记长度必须大于 0/
  );
  assert.throws(
    () => computeImposition({ ...BASE, ...FIT, productionMarks: true, markLengthMm: 200 }),
    /不能超过 100mm/
  );
});

test('余量充足：每张纸落位 4 裁切 + 2 折线 + 4 套准，共 10 个标记，无省略', () => {
  const r = computeImposition({ ...BASE, ...FIT, productionMarks: true });
  assert.equal(r.productionMarks.enabled, true);
  assert.equal(r.productionMarks.markLengthMm, 5);
  assert.equal(r.productionMarks.markGapMm, 3);
  assert.equal(r.productionMarks.totalMarks, 20); // 2 张 × 10
  assert.equal(r.productionMarks.placedMarks, 20);
  assert.equal(r.productionMarks.omittedMarks, 0);
  assert.deepEqual(r.productionMarks.byType.crop, { total: 8, placed: 8, omitted: 0 });
  assert.deepEqual(r.productionMarks.byType.fold, { total: 4, placed: 4, omitted: 0 });
  assert.deepEqual(r.productionMarks.byType.register, { total: 8, placed: 8, omitted: 0 });

  allSheets(r).forEach((sheet) => {
    const pm = sheet.productionMarks;
    assert.equal(pm.placedCount, 10);
    assert.equal(pm.omittedCount, 0);
    assert.deepEqual(pm.omitted, []);
    const ids = pm.front.map((m) => m.id);
    assert.deepEqual(ids, [
      'crop-tl', 'crop-tr', 'crop-bl', 'crop-br',
      'fold-top', 'fold-bottom',
      'register-1', 'register-2', 'register-3', 'register-4',
    ]);
    // 标准候选位全部可用时候选序号均为 0（套准十字共享候选中心：
    // 中心 2 / 5 落在出血框内被跳过，后续十字退到后续可用中心）
    pm.front.filter((m) => m.type !== 'register').forEach((m) => assert.equal(m.candidateIndex, 0));
    // 每个标记都是水平 / 垂直线段，且完整落在纸内
    pm.front.forEach((m) => {
      m.segments.forEach((s) => assert.equal(segmentInPaper(s, FIT.paperWidth, FIT.paperHeight), true));
    });
    // 折线标位于对折中线，线段关于 x = W/2 对称
    const foldTop = pm.front.find((m) => m.id === 'fold-top');
    const [t] = foldTop.segments;
    assert.equal(t.x1 + t.x2, FIT.paperWidth);
  });
});

test('避让出血框：线段不穿入任一侧出血框（含与边界相贴允许）', () => {
  const r = computeImposition({ ...BASE, ...FIT, productionMarks: true });
  allSheets(r).forEach((sheet) => {
    const boxes = [
      sheet.front.left.fit.bleedBox, sheet.front.right.fit.bleedBox,
      sheet.back.left.fit.bleedBox, sheet.back.right.fit.bleedBox,
    ];
    sheet.productionMarks.front.forEach((m) => {
      m.segments.forEach((s) => {
        boxes.forEach((b) => assert.equal(segmentIntersectsRect(s, b), false, `${m.id} 穿入出血框`));
      });
    });
  });
});

test('标记之间不相交（套准十字自身两段端点相触允许，不同标记不接触）', () => {
  const r = computeImposition({ ...BASE, ...FIT, productionMarks: true });
  allSheets(r).forEach((sheet) => {
    const marks = sheet.productionMarks.front;
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        marks[i].segments.forEach((s1) => {
          marks[j].segments.forEach((s2) => {
            assert.equal(segmentsIntersect(s1, s2), false, `${marks[i].id} 与 ${marks[j].id} 相交`);
          });
        });
      }
    }
  });
});

test('短边翻转：背面 = 正面 (x, y) → (W − x, y)，物理位置一一对应保证套准', () => {
  const r = computeImposition({ ...BASE, ...FIT, flip: 'short', productionMarks: true });
  const sheet = r.signatures[0].sheets[0].productionMarks;
  assert.equal(sheet.front.length, sheet.back.length);
  sheet.front.forEach((f, i) => {
    const b = sheet.back[i];
    assert.equal(b.id, f.id);
    assert.equal(b.type, f.type);
    f.segments.forEach((fs, k) => {
      const bs = b.segments[k];
      assert.equal(bs.x1, round(FIT.paperWidth - fs.x1));
      assert.equal(bs.x2, round(FIT.paperWidth - fs.x2));
      assert.equal(bs.y1, fs.y1);
      assert.equal(bs.y2, fs.y2);
    });
  });
});

test('长边翻转：背面 = 正面 (x, y) → (x, H − y)', () => {
  const r = computeImposition({ ...BASE, ...FIT, flip: 'long', productionMarks: true });
  const sheet = r.signatures[0].sheets[0].productionMarks;
  sheet.front.forEach((f, i) => {
    const b = sheet.back[i];
    f.segments.forEach((fs, k) => {
      const bs = b.segments[k];
      assert.equal(bs.x1, fs.x1);
      assert.equal(bs.x2, fs.x2);
      assert.equal(bs.y1, round(FIT.paperHeight - fs.y1));
      assert.equal(bs.y2, round(FIT.paperHeight - fs.y2));
    });
  });
});

test('爬移变化后标记位置同步重算（候选基于含 offsetMm 的出血框）', () => {
  const without = computeImposition({ ...BASE, ...FIT, productionMarks: true });
  const withCreep = computeImposition({
    ...BASE, ...FIT, productionMarks: true,
    paperThickness: 0.5, maxCompensation: 5,
  });
  // 第 2 张左页位爬移 +1mm（左装订），左上角线锚点应整体右移 1mm
  const m1 = without.signatures[0].sheets[1].productionMarks.front.find((m) => m.id === 'crop-tl');
  const m2 = withCreep.signatures[0].sheets[1].productionMarks.front.find((m) => m.id === 'crop-tl');
  assert.equal(withCreep.signatures[0].sheets[1].front.left.offsetMm, 1);
  m1.segments.forEach((s1, k) => {
    const s2 = m2.segments[k];
    assert.equal(s2.x1 - s1.x1, 1);
    assert.equal(s2.x2 - s1.x2, 1);
    assert.equal(s2.y1, s1.y1);
  });
});

test('余量不足：标记被省略并返回逐候选原因（440×310 + 出血 3）', () => {
  const r = computeImposition({
    ...BASE,
    paperWidth: 440, paperHeight: 310, pageWidth: 210, pageHeight: 297, bleedMm: 3,
    productionMarks: true,
  });
  const pm = r.signatures[0].sheets[0].productionMarks;
  // 四角裁切线无任何纸内候选（出血框顶 / 底贴纸边），套准十字全部穿入出血框；
  // 仅上 / 下折线标能退到「贴纸边」候选位
  assert.ok(pm.placedCount >= 1);
  assert.ok(pm.omittedCount >= 8);
  assert.ok(pm.omitted.some((o) => o.id === 'crop-tl'));
  assert.ok(pm.omitted.every((o) => ['crop-tl', 'crop-tr', 'crop-bl', 'crop-br', 'register-1', 'register-2', 'register-3', 'register-4'].includes(o.id)));
  const cropTL = pm.omitted.find((o) => o.id === 'crop-tl');
  assert.equal(cropTL.reasonCode, 'out-of-paper');
  pm.omitted.forEach((o) => {
    assert.ok(o.reason);
    assert.ok(o.candidatesTried >= 3);
    assert.equal(o.failures.length, o.candidatesTried);
    // 每个失败候选都带机器可读原因码
    o.failures.forEach((f) => assert.ok(['out-of-paper', 'bleed-overlap', 'mark-overlap'].includes(f.code)));
  });
  assert.ok(r.productionMarks.omittedMarks >= 16); // 2 张，每张至少 8 个省略
});

test('标记尺寸开关：自定义线长 / 间隙生效且随尺寸重算', () => {
  const r = computeImposition({ ...BASE, ...FIT, productionMarks: true, markLengthMm: 4, markGapMm: 2 });
  assert.equal(r.productionMarks.markLengthMm, 4);
  assert.equal(r.productionMarks.markGapMm, 2);
  const fold = r.signatures[0].sheets[0].productionMarks.front.find((m) => m.id === 'fold-top');
  const [t] = fold.segments;
  assert.equal(t.x2 - t.x1, 8); // 2 × 线长
});

test('placeOneSide：候选按固定顺序尝试，标准位被占用时退到后续候选', () => {
  // 出血框铺满纸面（无外边距）：标准候选必在纸外；只可能落到折线两侧通道
  const W = 200;
  const H = 100;
  const boxes = [
    { x: 0, y: 0, width: 100, height: 100 },
    { x: 100, y: 0, width: 100, height: 100 },
  ];
  const { placed, omitted } = placeOneSide(boxes, { paperWidth: W, paperHeight: H }, { markLengthMm: 2, markGapMm: 2 });
  // 四角裁切线、上 / 下折线标、外角套准十字均无位置
  assert.ok(omitted.length > 0);
  assert.ok(omitted.some((o) => o.id === 'crop-tl'));
  // 省略原因汇总为 out-of-paper（全部候选最常见的失败是落在纸外）
  const cropTL = omitted.find((o) => o.id === 'crop-tl');
  assert.equal(cropTL.reasonCode, 'out-of-paper');
  // 折线两侧通道里的套准十字候选不穿入出血框，但与纸张边缘关系决定能否落位
  placed.forEach((m) => {
    m.segments.forEach((s) => {
      assert.equal(segmentInPaper(s, W, H), true);
      boxes.forEach((b) => assert.equal(segmentIntersectsRect(s, b), false));
    });
  });
});

test('transformMarksToBack：背面线段完整保留标记身份与候选序号', () => {
  const placed = [
    { id: 'x', type: 'crop', name: 'x', candidateIndex: 2, segments: [{ x1: 1, y1: 2, x2: 3, y2: 4 }] },
  ];
  const back = transformMarksToBack(placed, 'long', 100, 50);
  assert.equal(back[0].id, 'x');
  assert.equal(back[0].candidateIndex, 2);
  assert.deepEqual(back[0].segments, [{ x1: 1, y1: 48, x2: 3, y2: 46 }]);
});

test('启用生产标记不改变页码拼版、爬移与适配检查结果', () => {
  const strip = (r) => JSON.parse(JSON.stringify(
    r,
    (k, v) => {
      if (k === 'productionMarks' || k === 'productionMarks') return undefined;
      // 入参回显中的生产标记字段也剔除（仅开关与尺寸回显差异，与拼版结果无关）
      if (k === 'markLengthMm' || k === 'markGapMm') return undefined;
      return v;
    }
  ));
  const common = { ...BASE, ...FIT, paperThickness: 0.1, maxCompensation: 0.15 };
  const without = computeImposition(common);
  const withMarks = computeImposition({ ...common, productionMarks: true });
  assert.deepEqual(strip(withMarks), strip(without));
});

test('试印核验重算四种组合时不携带生产标记（核验结论不受影响）', () => {
  const r = computeImposition({
    ...BASE, ...FIT,
    productionMarks: true,
    observations: [
      { signature: 1, sheet: 1, side: 'front', position: 'left', page: 8, orientation: 'upright' },
      { signature: 1, sheet: 1, side: 'back', position: 'left', page: 2, orientation: 'upright' },
    ],
  });
  assert.equal(r.verification.enabled, true);
  assert.equal(r.verification.conclusion.status, 'verified');
});

function round(n) {
  const v = Math.round(n * 10000) / 10000;
  return Object.is(v, -0) ? 0 : v;
}
