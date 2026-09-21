'use strict';

/**
 * 双面生产标记（production marks）。
 *
 * 启用适配检查后，为每张纸的正、背面生成三类生产标记：
 * - 裁切线（crop）：出血框外角处的双段角线，沿裁切边指示裁切位置；
 * - 折线标（fold）：沿对折中线（x = W/2）上、下各一条水平短线；
 * - 套准十字（register）：十字套准标记（共尝试放置 4 个），用于正背套准。
 *
 * 每个标记按固定候选位置顺序逐个尝试，只有同时满足：
 *   1. 标记的全部线段完整落在纸张矩形 [0, W] × [0, H] 内（允许贴边）；
 *   2. 线段不穿入两侧（左 / 右页位）出血框（允许与出血框边界相贴，
 *      折线一侧出血进入相邻页位属正常工艺，与适配检查口径一致）；
 *   3. 线段不与本张纸上已经落位的其他标记相交（端点相触也算冲突）；
 * 时才在该候选位置落位；全部候选均不可用时省略该标记，并逐个返回
 * 候选失败原因（out-of-paper / bleed-overlap / mark-overlap）与汇总原因。
 *
 * 正面标记先在纸张坐标系（原点左上角，x 向右、y 向下，单位 mm）落位；
 * 背面标记不另行排布，而是把正面标记做同一物理位置的坐标变换：
 *   - 长边翻转：(x, y) → (x, H − y)（绕水平长边翻转）
 *   - 短边翻转：(x, y) → (W − x, y)（绕垂直短边翻转）
 * 因此正、背面标记在纸张物理位置上一一对应，保证正背套准。候选位置
 * 基于含爬移偏移的出血框计算，爬移 / 尺寸 / 标记尺寸变化后随适配检查
 * 同步重算。
 *
 * 未启用（productionMarks 缺省 / false）时返回 { enabled: false }，
 * 拼版、爬移、适配检查与试印核验结果完全不受影响。
 */

const EPS = 1e-9;

const DEFAULT_MARK_LENGTH_MM = 5;
const DEFAULT_MARK_GAP_MM = 3;
const MAX_MARK_SIZE_MM = 100;
/** 每张纸每面尝试放置的套准十字个数。 */
const REGISTER_TARGET = 4;

const TYPE_LABELS = { crop: '裁切线', fold: '折线标', register: '套准十字' };
/** 失败阶段先后顺序：候选能通过的校验越靠后，越接近可落位。 */
const FAIL_STAGE = { 'out-of-paper': 0, 'bleed-overlap': 1, 'mark-overlap': 2 };

/** 保留 4 位小数（与拼版核心 / 适配检查一致，避免浮点尾数进入 JSON）。 */
function round4(n) {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * 解析标记尺寸参数（mm）。
 * 缺省（undefined / null）取默认值；空串、负数、非数字返回 NaN 由调用方报错。
 */
function toMarkMm(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n;
}

/**
 * 解析双面生产标记输入。
 * @param {object} input 原始请求体
 * @param {boolean} fitEnabled 是否已启用适配检查（标记落位依赖出血框坐标）
 */
function parseProductionMarksInput(input, fitEnabled) {
  if (input && input.productionMarks !== undefined && typeof input.productionMarks !== 'boolean') {
    throw new Error('双面生产标记开关必须为布尔值（true / false）');
  }
  const enabled = Boolean(input && input.productionMarks === true);
  const markLengthMm = toMarkMm(input && input.markLengthMm, DEFAULT_MARK_LENGTH_MM);
  const markGapMm = toMarkMm(input && input.markGapMm, DEFAULT_MARK_GAP_MM);
  if (Number.isNaN(markLengthMm)) {
    throw new Error('标记长度必须为 ≥ 0 的数字（单位 mm）');
  }
  if (Number.isNaN(markGapMm)) {
    throw new Error('标记间隙必须为 ≥ 0 的数字（单位 mm）');
  }
  if (markLengthMm > MAX_MARK_SIZE_MM || markGapMm > MAX_MARK_SIZE_MM) {
    throw new Error(`标记长度 / 间隙不能超过 ${MAX_MARK_SIZE_MM}mm`);
  }
  if (enabled) {
    if (!fitEnabled) {
      throw new Error('启用双面生产标记必须先启用适配检查：请同时提供纸张宽 / 高与成品页宽 / 高，标记位置依赖出血框坐标');
    }
    if (!(markLengthMm > 0)) {
      throw new Error('启用双面生产标记时标记长度必须大于 0（单位 mm）');
    }
  }
  return { enabled, markLengthMm, markGapMm };
}

/* ------------------------------ 几何判定 ------------------------------ */

/** 线段是否完整落在纸张矩形内（端点允许贴边）。 */
function segmentInPaper(s, W, H) {
  return [s.x1, s.x2].every((x) => x >= -EPS && x <= W + EPS)
    && [s.y1, s.y2].every((y) => y >= -EPS && y <= H + EPS);
}

/**
 * 线段是否穿入矩形「内部」（严格相交）。
 * 与矩形边界重合、仅端点相贴都不算穿入——出血框外边界本身就是允许的最近位置。
 * 全部标记线段均为水平 / 垂直线段。
 */
function segmentIntersectsRect(s, rect) {
  const xMin = Math.min(s.x1, s.x2);
  const xMax = Math.max(s.x1, s.x2);
  const yMin = Math.min(s.y1, s.y2);
  const yMax = Math.max(s.y1, s.y2);
  if (Math.abs(yMin - yMax) < EPS) {
    // 水平线段：y 严格位于矩形上下边之间，且 x 区间与矩形开区间有正长度重叠
    if (s.y1 <= rect.y + EPS || s.y1 >= rect.y + rect.height - EPS) return false;
    return Math.min(xMax, rect.x + rect.width) - Math.max(xMin, rect.x) > EPS;
  }
  if (Math.abs(xMin - xMax) < EPS) {
    // 垂直线段
    if (s.x1 <= rect.x + EPS || s.x1 >= rect.x + rect.width - EPS) return false;
    return Math.min(yMax, rect.y + rect.height) - Math.max(yMin, rect.y) > EPS;
  }
  return false; // 生产标记只含水平 / 垂直线段
}

/**
 * 两条线段是否相交（闭合判定：端点相触、共线重叠都算相交）。
 * 用于「不与已放置标记相交」校验。
 */
function segmentsIntersect(a, b) {
  const aHorizontal = Math.abs(a.y1 - a.y2) < EPS;
  const bHorizontal = Math.abs(b.y1 - b.y2) < EPS;
  if (aHorizontal && bHorizontal) {
    if (Math.abs(a.y1 - b.y1) > EPS) return false;
    const lo = Math.max(Math.min(a.x1, a.x2), Math.min(b.x1, b.x2));
    const hi = Math.min(Math.max(a.x1, a.x2), Math.max(b.x1, b.x2));
    return hi - lo > EPS;
  }
  if (!aHorizontal && !bHorizontal) {
    if (Math.abs(a.x1 - b.x1) > EPS) return false;
    const lo = Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2));
    const hi = Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2));
    return hi - lo > EPS;
  }
  // 一水平一垂直：水平线段的 y 落在垂直线段 y 区间内，且垂直线段的 x 落在水平线段 x 区间内
  const h = aHorizontal ? a : b;
  const v = aHorizontal ? b : a;
  return h.y1 >= Math.min(v.y1, v.y2) - EPS
    && h.y1 <= Math.max(v.y1, v.y2) + EPS
    && v.x1 >= Math.min(h.x1, h.x2) - EPS
    && v.x1 <= Math.max(h.x1, h.x2) + EPS;
}

/* ------------------------------ 候选位置 ------------------------------ */

const seg = (x1, y1, x2, y2) => ({ x1, y1, x2, y2 });

/**
 * 四角裁切线候选位置（每角 3 个，固定顺序：标准位 → 沿裁切边向纸内退 1/2 个线长）。
 * 角线锚点为两侧出血框并集的外角；标准位在锚点外侧留出间隙 gap。
 */
function cropCandidates(ext, L, g) {
  const { left: xL, right: xR, top: yT, bottom: yB } = ext;
  return {
    'crop-tl': [
      { segments: [seg(xL, yT - g - L, xL, yT - g), seg(xL - g - L, yT, xL - g, yT)] },
      { segments: [seg(xL + L, yT - g - L, xL + L, yT - g), seg(xL, yT - g - L, xL + L, yT - g - L)] },
      { segments: [seg(xL + 2 * L, yT - g - L, xL + 2 * L, yT - g), seg(xL, yT - g - 2 * L, xL + 2 * L, yT - g - 2 * L)] },
    ],
    'crop-tr': [
      { segments: [seg(xR, yT - g - L, xR, yT - g), seg(xR + g, yT, xR + g + L, yT)] },
      { segments: [seg(xR - L, yT - g - L, xR - L, yT - g), seg(xR - L, yT - g - L, xR, yT - g - L)] },
      { segments: [seg(xR - 2 * L, yT - g - L, xR - 2 * L, yT - g), seg(xR - 2 * L, yT - g - 2 * L, xR, yT - g - 2 * L)] },
    ],
    'crop-bl': [
      { segments: [seg(xL, yB + g, xL, yB + g + L), seg(xL - g - L, yB, xL - g, yB)] },
      { segments: [seg(xL + L, yB + g, xL + L, yB + g + L), seg(xL, yB + g + L, xL + L, yB + g + L)] },
      { segments: [seg(xL + 2 * L, yB + g, xL + 2 * L, yB + g + L), seg(xL, yB + g + 2 * L, xL + 2 * L, yB + g + 2 * L)] },
    ],
    'crop-br': [
      { segments: [seg(xR, yB + g, xR, yB + g + L), seg(xR + g, yB, xR + g + L, yB)] },
      { segments: [seg(xR - L, yB + g, xR - L, yB + g + L), seg(xR - L, yB + g + L, xR, yB + g + L)] },
      { segments: [seg(xR - 2 * L, yB + g, xR - 2 * L, yB + g + L), seg(xR - 2 * L, yB + g + 2 * L, xR, yB + g + 2 * L)] },
    ],
  };
}

/** 上 / 下折线标候选位置（水平短线，以对折中线为中心）。 */
function foldCandidates(ext, W, H, L, g) {
  const fx = W / 2;
  const tick = (y) => ({ segments: [seg(fx - L, y, fx + L, y)] });
  return {
    'fold-top': [
      tick(ext.top - g - L),
      tick(ext.top - g - 2 * L),
      tick(g),
    ],
    'fold-bottom': [
      tick(ext.bottom + g + L),
      tick(ext.bottom + g + 2 * L),
      tick(H - g), // 贴纸张下边
    ],
  };
}

/**
 * 套准十字候选中心（10 个，固定顺序）：
 * 先上排（左外角 → 右外角 → 折线上方），再下排，最后折线两侧的侧部位置。
 * 十字由水平、垂直两段组成，半臂长 = L / 2。
 */
function registerCandidates(ext, W, L, g) {
  const fx = W / 2;
  const A = L / 2;
  const centers = [
    [ext.left + g + A, ext.top - g - A],
    [ext.right - g - A, ext.top - g - A],
    [fx, ext.top - g - A],
    [ext.left + g + A, ext.bottom + g + A],
    [ext.right - g - A, ext.bottom + g + A],
    [fx, ext.bottom + g + A],
    [fx - g - A, ext.top + g + A],
    [fx + g + A, ext.top + g + A],
    [fx - g - A, ext.bottom - g - A],
    [fx + g + A, ext.bottom - g - A],
  ];
  return centers.map(([cx, cy]) => ({
    segments: [
      seg(cx - A, cy, cx + A, cy),
      seg(cx, cy - A, cx, cy + A),
    ],
  }));
}

const MARK_NAMES = {
  'crop-tl': '裁切线（左上）',
  'crop-tr': '裁切线（右上）',
  'crop-bl': '裁切线（左下）',
  'crop-br': '裁切线（右下）',
  'fold-top': '折线标（上）',
  'fold-bottom': '折线标（下）',
};

const FAIL_MESSAGES = {
  'out-of-paper': (i, W, H) => `候选 ${i + 1}：有线段超出纸张范围（纸张 ${round4(W)}×${round4(H)}mm）`,
  'bleed-overlap': () => '候选位置：线段穿入左 / 右页位出血框',
  'mark-overlap': (i, W, H, other) => `候选位置：与已放置的「${other}」线段相交`,
};

/**
 * 在一张纸的一面上按固定顺序放置全部生产标记。
 *
 * @param {Array<object>} bleedBoxes 该张纸四个页位的出血框（{ x,y,width,height }，mm）
 * @param {object} size { paperWidth, paperHeight }
 * @param {object} opts { markLengthMm, markGapMm }
 * @returns {{ placed: Array, omitted: Array }}
 */
function placeOneSide(bleedBoxes, size, opts) {
  const { paperWidth: W, paperHeight: H } = size;
  const L = opts.markLengthMm;
  const g = opts.markGapMm;

  // 两侧出血框并集的外角（左 / 右出血框可能因爬移偏移而不完全对称）
  const ext = {
    left: Math.min(...bleedBoxes.map((b) => b.x)),
    right: Math.max(...bleedBoxes.map((b) => b.x + b.width)),
    top: Math.min(...bleedBoxes.map((b) => b.y)),
    bottom: Math.max(...bleedBoxes.map((b) => b.y + b.height)),
  };

  const placed = [];
  const omitted = [];

  /** 按候选顺序尝试放置一个标记；全部候选失败则记入 omitted。 */
  function tryPlace(id, type, name, candidates) {
    const failures = [];
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      let code = null;
      let conflictsWith = null;
      if (!candidate.segments.every((s) => segmentInPaper(s, W, H))) {
        code = 'out-of-paper';
      } else if (candidate.segments.some((s) => bleedBoxes.some((b) => segmentIntersectsRect(s, b)))) {
        code = 'bleed-overlap';
      } else {
        for (const s of candidate.segments) {
          const hit = placed.find((p) => p.segments.some((ps) => segmentsIntersect(s, ps)));
          if (hit) {
            code = 'mark-overlap';
            conflictsWith = hit.name;
            break;
          }
        }
      }
      if (!code) {
        placed.push({
          id,
          type,
          name,
          candidateIndex: i,
          segments: candidate.segments.map((s) => ({
            x1: round4(s.x1), y1: round4(s.y1), x2: round4(s.x2), y2: round4(s.y2),
          })),
        });
        return;
      }
      failures.push({ candidateIndex: i, code, message: FAIL_MESSAGES[code](i, W, H, conflictsWith) });
    }
    // 汇总原因：取「走得最远」的候选所遇到的失败类型
    let deepest = failures[0];
    failures.forEach((f) => {
      if (FAIL_STAGE[f.code] > FAIL_STAGE[deepest.code]) deepest = f;
    });
    const n = candidates.length;
    const reasonByCode = {
      'out-of-paper': `全部 ${n} 个候选位置均落在纸张外：纸边到出血框之间没有足够空间（可尝试更小的标记尺寸或减小出血）`,
      'bleed-overlap': `全部候选位置要么落在纸张外，要么线段穿入两侧出血框：出血框距纸边的空白区域不足（可尝试更小的标记尺寸或减小出血）`,
      'mark-overlap': `全部候选位置均不可用：线段落在纸张外、穿入出血框或与已放置标记相交（纸边可用空间不足）`,
    };
    omitted.push({
      id,
      type,
      name,
      candidatesTried: n,
      reasonCode: deepest.code,
      reason: reasonByCode[deepest.code],
      failures,
    });
  }

  // 固定放置顺序：四角裁切线 → 上 / 下折线标 → 4 个套准十字
  const crops = cropCandidates(ext, L, g);
  ['crop-tl', 'crop-tr', 'crop-bl', 'crop-br'].forEach((id) => {
    tryPlace(id, 'crop', MARK_NAMES[id], crops[id]);
  });
  const folds = foldCandidates(ext, W, H, L, g);
  ['fold-top', 'fold-bottom'].forEach((id) => {
    tryPlace(id, 'fold', MARK_NAMES[id], folds[id]);
  });
  // 每个套准十字都按同一组候选中心顺序尝试；已被前一个十字占用的中心会因
  // mark-overlap 自动跳过，从而落位到下一个可用中心。
  const registerCand = registerCandidates(ext, W, L, g);
  for (let k = 1; k <= REGISTER_TARGET; k++) {
    tryPlace(`register-${k}`, 'register', `套准十字 ${k}`, registerCand);
  }

  return { placed, omitted };
}

/**
 * 正面标记变换到背面（同一物理位置）：
 * 长边翻转 (x, y) → (x, H − y)；短边翻转 (x, y) → (W − x, y)。
 */
function transformMarksToBack(placed, flip, W, H) {
  return placed.map((m) => ({
    id: m.id,
    type: m.type,
    name: m.name,
    candidateIndex: m.candidateIndex,
    segments: m.segments.map((s) => (
      flip === 'long'
        ? { x1: round4(s.x1), y1: round4(H - s.y1), x2: round4(s.x2), y2: round4(H - s.y2) }
        : { x1: round4(W - s.x1), y1: round4(s.y1), x2: round4(W - s.x2), y2: round4(s.y2) }
    )),
  }));
}

/**
 * 对拼版结果逐张纸附加双面生产标记：
 * 每张纸对象增加 productionMarks（front / back / omitted），顶层返回汇总。
 *
 * @param {object} result computeImposition 的返回结果（须已附加 fit）
 * @param {object} pm     parseProductionMarksInput 的解析结果
 * @returns {object} 顶层 productionMarks 汇总
 */
function attachProductionMarks(result, pm) {
  if (!pm.enabled) {
    return { enabled: false };
  }
  const W = result.fit.paperWidth;
  const H = result.fit.paperHeight;
  const flip = result.input.flip;

  let placedMarks = 0;
  let omittedMarks = 0;
  const byType = {
    crop: { total: 0, placed: 0, omitted: 0 },
    fold: { total: 0, placed: 0, omitted: 0 },
    register: { total: 0, placed: 0, omitted: 0 },
  };

  result.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      // 取该张纸四个页位（正面左右 + 背面左右）的出血框作为避让框；
      // 出血框已含爬移偏移，爬移变化后随适配检查一起重算。
      const bleedBoxes = [
        sheet.front.left.fit.bleedBox,
        sheet.front.right.fit.bleedBox,
        sheet.back.left.fit.bleedBox,
        sheet.back.right.fit.bleedBox,
      ];
      const { placed, omitted } = placeOneSide(bleedBoxes, { paperWidth: W, paperHeight: H }, pm);
      const back = transformMarksToBack(placed, flip, W, H);

      placed.forEach((m) => {
        byType[m.type].total += 1;
        byType[m.type].placed += 1;
        placedMarks += 1;
      });
      omitted.forEach((m) => {
        byType[m.type].total += 1;
        byType[m.type].omitted += 1;
        omittedMarks += 1;
      });

      sheet.productionMarks = {
        front: placed,
        back,
        omitted,
        placedCount: placed.length,
        omittedCount: omitted.length,
      };
    });
  });

  return {
    enabled: true,
    markLengthMm: pm.markLengthMm,
    markGapMm: pm.markGapMm,
    paperWidth: W,
    paperHeight: H,
    flip,
    sheetCount: result.signatures.reduce((sum, sig) => sum + sig.sheets.length, 0),
    totalMarks: placedMarks + omittedMarks,
    placedMarks,
    omittedMarks,
    byType,
  };
}

module.exports = {
  parseProductionMarksInput,
  attachProductionMarks,
  placeOneSide,
  transformMarksToBack,
  segmentInPaper,
  segmentIntersectsRect,
  segmentsIntersect,
  DEFAULT_MARK_LENGTH_MM,
  DEFAULT_MARK_GAP_MM,
  TYPE_LABELS,
};
