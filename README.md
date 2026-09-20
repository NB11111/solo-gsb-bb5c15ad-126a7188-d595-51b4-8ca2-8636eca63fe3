# 骑马钉小册子拼版预演

基于 **Node.js + Express + 原生 Canvas** 的骑马钉（saddle-stitch）拼版预演 Web 应用。

输入成品页数、每帖张数上限、装订方向与双面翻转方式后，系统会：

- 成品页数不足整帖时，**自动在末尾补空白页**；
- **固定分帖（默认）**：每帖固定张数（每帖页数 = 每帖张数 × 4），末帖不足整体补白；
- **均衡分帖（可选）**：仍以每帖张数为上限，先取最少帖数，再把整本所需纸张在各帖间均匀分配，**各帖实际张数差不超过 1**，各帖按自身页数连续编号，**空白页只出现在末帖末尾**；每帖返回 `actualSheetCount`，并汇总相对固定分帖 `savedBlankPages` 节省的空白页数；
- **章节优先分帖（可选）**：输入递增的章节起始页，系统在每帖不超过张数上限、每帖纸张数为整数的前提下规划连续页段，按「**章节被拆分次数最少 → 补白页总数最少 → 帖数最少 → 前帖优先装满**」确定唯一方案；章节末尾允许插入帖内空白，后续真实页码保持连续并正确进入下一帖；逐帖展示覆盖章节、真实页范围与补白位置；
- **按帖拆分页码**，生成每张纸正、反面的左右页位；
- 背面依据 **长边 / 短边翻转** 执行坐标变换，保证裁切折叠后的阅读顺序；
- 可选 **爬移补偿（creep compensation）**：按纸张厚度由外向内平移内层页位，画布叠加原始页位虚线框与补偿后实线框，每个页位（含空白页）输出 `offsetMm`；均衡分帖下按**各帖实际层数**独立重算；
- 可选 **纸张规格与出血 / 安全区适配检查**：输入纸张宽高、成品页宽高、出血与安全边距后，按每个正反页位的实际方向计算可用矩形，逐页位判定成品页是否放得下、出血是否落在纸张内、安全边距是否过大，并在逐张预览与清单中标出不合格页位；
- 可选 **试印核验**：对照实物纸张录入 1～12 条观察（帖 / 张 / 正背面 / 左右页位 / 看到的页码或空白 / 内容朝向），服务端用同一输入重算「左/右装订 × 长/短边翻转」四种设置逐条比对，仅唯一零差异组合判定验证通过，并列最优时返回无法判定及并列组合；**无法判定时自动从尚未观察的页位计算「下一处观察建议」**（含定位与各候选预期值）；
- 画布**逐张显示**纸面、页码、空白页位与翻转方向示意；
- 一键**导出拼版清单 JSON**（包含适配检查与试印核验结果）。

## 快速开始（Docker）

```bash
docker compose up --build
```

启动后访问：**http://localhost:8080**

## 本地开发

```bash
npm install
npm start          # 启动服务，默认 8080 端口（可用 PORT 环境变量覆盖）
npm test           # 运行拼版逻辑单元测试
```

## 拼版规则说明

- **帖与张**：一帖由若干张纸叠放对折而成，每张纸正反面各印 2 页，故每帖页数 = 每帖张数 × 4。
- **页码配对**：同一帖内由外向内，第 i 张纸的正面为「最大未排页 + 最小未排页」，背面为与其相邻的两页。
- **装订方向**：
  - 左装订：第 1 页在正面右页位（书脊在左）；
  - 右装订：镜像，第 1 页在正面左页位（书脊在右）。
- **双面翻转（背面坐标变换，纸张坐标系与正面同视角）**：
  - 长边翻转：绕水平长边翻转，`(x, y) → (x, H − y)`，背面左右页位不变，内容旋转 180°（页首朝下）；
  - 短边翻转：绕垂直短边翻转，`(x, y) → (W − x, y)`，背面左右页位互换，内容方向不变。
- **阅读顺序校验**：画布上每个背面页位都标注了它物理上位于哪一正面页之背（页码首尾相接）。

### 均衡分帖（balanced split）

表单勾选「均衡分帖」（API 传 `balancedSplit: true`）后启用；不勾选 / 不传 / 传 `false` 时为**固定分帖**，结果与旧版本完全一致。

规则（`N` = 成品页数，`S` = 每帖张数上限）：

- 每帖容量仍为 `4S` 页，故**最少帖数** `k = ceil(N / 4S)`，与固定分帖的帖数相同；
- 整本所需纸张 `T = ceil(N / 4)` 在 `k` 帖间均匀分配：每帖 `floor(T/k)` 或 `ceil(T/k)` 张，**各帖实际张数差不超过 1**（多出的帖依次靠前分配），且任何一帖都不超过上限 `S`；
- 各帖按自身页数**连续编号**，页码范围首尾相接；空白页只补在末帖（页码最大的若干页位，即末帖外层高号页与其背面），**前面各帖均无空白页**；
- 每帖返回 `actualSheetCount` / `actualPageCount` / `blankPages` 与该帖的 `sheetCompensationMm`；
- 顶层汇总 `balanced`：`fixedPaddedPages`（固定分帖补白后页数）、`savedBlankPages = fixedPaddedPages − paddedPages`（相对固定分帖节省的空白页数）、`actualSheetCounts`（各帖实际张数）等；
- 爬移补偿按**该帖实际层数**（实际张数）由外向内独立重算；顶层 `creep.sheetCompensationMm` 仍按每帖张数上限给出，各帖以自身的 `sheetCompensationMm` 为准。

示例：17 页、每帖上限 2 张（8 页/帖）时，固定分帖为 `[8, 8, 8] = 24` 页、补 7 个空白页；均衡分帖为 `[2, 2, 1]` 张、`[8, 8, 4] = 20` 页，空白页仅 3 个且全部在末帖，`savedBlankPages = 4`。

### 章节优先分帖（chapter-first split）

表单勾选「章节优先分帖」并填写递增的章节起始页（API 传 `chapterSplit: true` + `chapterStarts: [...]`）后启用；与均衡分帖**互斥**（同时启用返回 400）。不勾选 / 不传 / 传 `false` 时为固定或均衡分帖，结果与旧版本完全一致（`chapterStarts` 被忽略）。

规则（`N` = 成品页数，`S` = 每帖张数上限）：

- **章节起始页**：严格递增的整数数组，取值范围 `1 ~ N`；首个起始页不为 1 时自动补上（第 1 章从第 1 页开始）。非法（非数组 / 空数组 / 非整数）、重复、未递增或越界的起始页都会返回明确错误；
- **约束**：每帖纸张数为整数（帖内页数为 4 的倍数）且不超过 `S` 张；帖内补白只允许出现在**章节末尾**（或全书末尾），章节中间断开时该帖必须恰好排满整数张；
- **优化目标**（按优先级逐项比较，保证唯一方案）：
  1. **章节被拆分次数最少**（一帖结尾落在章节中间计 1 次拆分）；
  2. **补白页总数最少**；
  3. **帖数最少**；
  4. **前帖优先装满**（前三项均并列时，让更靠前的帖容纳更多真实页）；
- **页码连续性**：章末帖内补白不占用页码，后续真实页码保持连续并正确进入下一帖；跨帖页码范围首尾相接；
- 每帖返回 `chapters`（本帖覆盖的章节及其页码范围）、真实页范围 `pageStart` / `pageEnd` 与 `blankPages`（补白位于本帖末尾的页位，页位对象中 `blank: true`）；顶层 `chapters` 汇总章节列表、拆分次数 `splitCount`、被拆分章节 `splitChapters` 与各帖实际张数 `actualSheetCounts`；
- 爬移补偿按各帖实际层数独立重算；适配检查照常逐页位执行（含章末补白页位）。

示例：20 页、每帖上限 2 张、章节起始页 `[1, 9, 14, 18]`（章 1–8 / 9–13 / 14–17 / 18–20）时，方案为 `[1–8]`、`[9–13]+3 页补白`、`[14–20]+1 页补白`，共 3 帖、0 次拆分、4 页补白；第 14 页正确进入第 3 帖首页。

顶层 `chapters` 汇总示例：

```json
{
  "enabled": true,
  "starts": [1, 9, 14, 18],
  "count": 4,
  "list": [
    { "index": 1, "pageStart": 1, "pageEnd": 8 },
    { "index": 2, "pageStart": 9, "pageEnd": 13 },
    { "index": 3, "pageStart": 14, "pageEnd": 17 },
    { "index": 4, "pageStart": 18, "pageEnd": 20 }
  ],
  "splitCount": 0,
  "splitChapters": [],
  "maxSheetsPerSignature": 2,
  "actualSheetCounts": [2, 2, 2]
}
```

### 爬移补偿（creep compensation）

骑马钉装订时内层纸页在书背处被向外推出，折页裁切后内层页会比外层短，需要把内层页位向切口方向平移补偿。表单中的两个可选参数（均为 mm）：

- **纸张厚度** `paperThickness`：单张纸的厚度；
- **最大补偿量** `maxCompensation`：单张纸补偿量的封顶值。

规则：

- 每帖第 `i` 张纸由外向内以 `0` 起算，补偿量 = `min(i × 纸张厚度 × 2, 最大补偿量)`（一张纸在折缝两侧各贡献一个厚度，故乘 2；各帖独立从 `i = 0` 起算）；
- 偏移符号：**左装订时左页位取正、右页位取负**；**右装订时符号整体反转**（左负右正）；
- 偏移与双面翻转方式无关，正、背面同方向平移；
- 每个页位（包括自动补齐的**空白页**）都输出 `offsetMm`；
- **纸张厚度或最大补偿量任一为 0（或缺省）时，所有 `offsetMm` 为 0，页码拼版结果与不启用时完全一致**（向后兼容）。

画布上橙色**虚线框**表示补偿前的原始页位，橙色**实线框**表示补偿后页位；画布位移为示意性放大（非真实 mm 等比），精确数值以清单和导出 JSON 中的 `offsetMm` 为准。

### 纸张规格与出血 / 安全区适配检查

表单中可选填写（均为 mm）：**纸张宽 / 高**、**成品页宽 / 高**、**出血**、**安全边距**。四项尺寸全部留空（或为 0）时不检查，行为与旧版本完全一致；一旦填写其中任意一项，四项尺寸必须全部大于 0，出血与安全边距缺省为 0。

检查规则（纸张坐标系，与正面同一视角）：

- 每个页位的**可用矩形**为纸张的一半：左页位 `[0, W/2] × [0, H]`，右页位 `[W/2, W] × [0, H]`；背面页位与正面共用同一坐标系（长边翻转左右不变、短边翻转左右互换），每个页位同时返回内容方向 `rotation`（长边翻转的背面为 180°，其余为 0°）；
- 成品页在页位内**居中放置**，并叠加该页位的爬移偏移 `offsetMm`，得到裁切框 `trim`；
- **出血框** `bleedBox` = `trim` 四边各外扩出血，必须完全落在纸张矩形内（折线一侧的出血进入相邻页位属正常工艺，仅纸张外边界构成约束）；
- **安全区** `safeBox` = `trim` 四边各内缩安全边距；`2 × 安全边距` 超过成品页宽 / 高时安全区不存在，记为超限。

每个页位（含空白页）输出 `fit`：`{ ok, rotation, rect, trim, bleedBox, safeBox, violations }`，`violations` 逐条给出超限原因（`page-too-wide` / `page-too-tall` / `bleed-overflow-{left,top,right,bottom}` / `safety-too-wide` / `safety-too-tall`，含具体超出量）；顶层 `fit` 汇总 `ok / totalSlots / failCount`。画布上蓝框 = 裁切线、绿/红虚框 = 出血范围（红 = 超出纸张）、灰点框 = 安全区，不合格页位带红色圆徽，清单对应单元格标红并列出原因。

### 试印核验（trial print verification）

生成拼版后，可在逐张预览旁对照实物纸张录入 **1～12 条观察**：帖、张、正/背面、左/右页位、看到的页码（或空白）以及内容朝向（正向 / 倒置 180°）。点击「开始核验」（已核验过时增删观察会自动重核）后，服务端用**同一输入**分别重算「左/右装订 × 长/短边翻转」四种设置，逐条比对：

- **页码 / 空白**：观察为空白时期望页位必须为空白；观察为页码时必须与期望页码一致；
- **内容朝向**：仅当观察与期望页位均非空白时比对（空白页无内容朝向，记为跳过）；正面恒为正向，背面长边翻转为倒置、短边翻转为正向。

每种设置统计**错误观察数**（任一字段不符即计）与**错误字段总数**，四种候选按「**错误观察数最少 → 错误字段数最少 → 当前设置优先 → 固定组合顺序**（左/短、左/长、右/短、右/长）」排序，结论分三种：

- **验证通过（`verified`）**：存在**唯一零差异组合**——若即当前设置则确认无误；若是其他组合，说明实物唯一对应另一组设置，结论中明确标出；
- **无法判定（`undetermined`）**：**并列最优**（含多个零差异组合，例如只做正面观察无法区分长/短边翻转）——返回全部并列组合，**不强行推荐**，需补充更有区分度的观察；服务端同时从未观察页位计算**下一处观察建议**（见下）；
- **验证未通过（`failed`）**：四种设置均有差异——给出最接近的组合及其差异数。

#### 下一处观察建议（next suggestion）

结论为无法判定时，服务端遍历所有**尚未观察**的页位，取各并列组合在该页位的预期结果（页码 / 空白 + 内容朝向），预期相同的组合归为一组——实物在该页位看到哪一组结果，就只剩该组的候选组合。全部页位按以下优先级逐项比较（全并列时仍保证唯一建议）：

1. **最坏情况下剩余候选数最少**（最大结果组的大小最小）——首要目标；
2. **可形成的结果分组数最多**（同样最坏剩余时区分更细）；
3. **非空白优先**（并列组合中预期该页位为空白的个数最少；空白页位对页码与朝向均无信息）；
4. **背面优先**（正面朝向恒为正向，只有背面能区分长 / 短边翻转）；
5. **帖号靠前 → 张号靠前 → 左页位优先**。

若所有未观察页位在各并列组合下的预期都完全一致（如 1 页册子无法区分长 / 短边翻转），则**明确返回无建议**（`nextSuggestion` 为 `null`，结论消息说明剩余页位均无法继续区分）。`verified` / `failed` 结论不出建议；无观察时流程不变。

建议对象含：定位（`signature` / `sheet` / `side` / `position`）、各并列候选的预期值 `candidates`（`binding` / `flip` / `blank` / `page` / `orientation`，按固定组合顺序）、结果分组 `outcomeGroups`（每组的预期值与落入该组的组合）、`groupCount` 与 `worstRemainingCandidates`。建议随观察增删在每次重算时同步刷新，且一定不指向已观察页位。

前端在无法判定横幅下展示建议框与**「查看建议」**按钮，点击跳到对应纸张并以青色框高亮建议页位；分组列出各候选预期（页码 / 空白 + 朝向）；增删观察或重新生成后建议同步刷新（已无建议时明确提示）。点击差异行（或观察列表中的条目）仍可跳到对应纸张并高亮页位；「导出拼版清单 JSON」中包含 `verification`（观察、候选评分、结论与 `nextSuggestion`）。非法索引（帖 / 张越界）、重复观察（同一帖 / 张 / 面 / 页位）与非法字段值都会返回 400 明确错误；不录入观察时流程与之前完全一致。

## API

### `POST /api/impose`

请求体：

```json
{
  "totalPages": 16,
  "sheetsPerSignature": 2,
  "balancedSplit": false,
  "chapterSplit": false,
  "chapterStarts": [],
  "binding": "left",
  "flip": "short",
  "paperThickness": 0.1,
  "maxCompensation": 2,
  "paperWidth": 440,
  "paperHeight": 310,
  "pageWidth": 210,
  "pageHeight": 297,
  "bleedMm": 3,
  "safetyMm": 5,
  "observations": [
    { "signature": 1, "sheet": 1, "side": "front", "position": "right", "page": 1, "orientation": "upright" },
    { "signature": 1, "sheet": 1, "side": "back", "position": "left", "page": null, "orientation": "upright" }
  ]
}
```

- `totalPages`：成品页数，1 ~ 10000 的整数
- `sheetsPerSignature`：每帖张数上限，1 ~ 100 的整数
- `balancedSplit`：**可选**，`true` 启用均衡分帖（在最少帖数间均匀分配纸张，各帖实际张数差 ≤ 1，空白页只留在末帖末尾）；缺省 / `false` 为固定分帖（向后兼容）
- `chapterSplit`：**可选**，`true` 启用章节优先分帖（与均衡分帖互斥）；缺省 / `false` 时 `chapterStarts` 被忽略，结果与旧版本完全一致
- `chapterStarts`：启用章节优先分帖时**必填**，严格递增的章节起始页数组（整数，1 ~ totalPages；首个不为 1 时自动补上第 1 章）；非法、重复、未递增或越界均返回 400 明确错误
- `binding`：`left`（左装订）或 `right`（右装订）
- `flip`：`long`（长边翻转）或 `short`（短边翻转）
- `paperThickness`：**可选**，纸张厚度（mm，≥ 0，缺省为 0）
- `maxCompensation`：**可选**，爬移最大补偿量（mm，≥ 0，缺省为 0）
- `paperWidth` / `paperHeight` / `pageWidth` / `pageHeight`：**可选**，纸张与成品页宽高（mm）；全部缺省或为 0 时不做适配检查，提供任意一项则四项必须全部 > 0
- `bleedMm` / `safetyMm`：**可选**，出血与安全边距（mm，≥ 0，缺省为 0）
- `observations`：**可选**，试印核验观察数组（1～12 条；缺省 / 空数组不启用核验，结果与旧版本完全一致）。每条：
  - `signature` / `sheet`：帖号 / 张号（1 起始整数；张号不超过该帖实际张数）
  - `side`：`front`（正面）/ `back`（背面）；`position`：`left`（左页位）/ `right`（右页位）
  - `page`：看到的页码（1 ~ totalPages 的整数），或 `null` 表示看到空白页
  - `orientation`：`upright`（正向）/ `rotated`（倒置 180°）
  - 同一帖 / 张 / 面 / 页位的重复观察、索引越界、字段非法均返回 400 明确错误

后两个爬移参数任一为 0（或不传）时不做爬移补偿，所有页位 `offsetMm` 为 0，旧调用方无需改动。

响应（节选）：完整拼版清单，与前端导出的 JSON 一致。`creep.sheetCompensationMm` 按每帖张数上限由外向内给出补偿量；**每个帖对象另带 `actualSheetCount`（实际张数）、`actualPageCount`（实际页数）、`blankPages`（本帖空白页数）与按该帖实际层数重算的 `sheetCompensationMm`**；每个页位对象（含空白页）都带 `offsetMm`；启用适配检查时每个页位另带 `fit`，顶层 `fit` 给出整体汇总。

顶层 `balanced` 汇总分帖模式：

- 固定分帖（`balancedSplit` 缺省 / `false`）：`{ "enabled": false }`；
- 均衡分帖：

```json
{
  "enabled": true,
  "maxSheetsPerSignature": 2,
  "totalSheets": 5,
  "fixedSignatureCount": 3,
  "fixedPaddedPages": 24,
  "fixedBlankPages": 7,
  "savedBlankPages": 4,
  "actualSheetCounts": [2, 2, 1]
}
```

顶层 `chapters` 汇总章节优先分帖：未启用时为 `{ "enabled": false }`；启用时包含规范化后的章节起始页 `starts`、章节列表 `list`、拆分总次数 `splitCount`、被拆分章节 `splitChapters` 与各帖实际张数 `actualSheetCounts`（结构见上文「章节优先分帖」一节）。章节模式下每个帖对象另带 `chapters`（本帖覆盖章节），`pageStart` / `pageEnd` 为**真实页范围**（补白页不占页码）。

```json
{
  "input": {
    "totalPages": 8,
    "sheetsPerSignature": 2,
    "balancedSplit": false,
    "binding": "left",
    "flip": "short",
    "paperThickness": 0.1,
    "maxCompensation": 0.15
  },
  "pagesPerSignature": 8,
  "signatureCount": 1,
  "paddedPages": 8,
  "blankPages": 0,
  "balanced": { "enabled": false },
  "creep": {
    "paperThickness": 0.1,
    "maxCompensation": 0.15,
    "enabled": true,
    "sheetCompensationMm": [0, 0.15]
  },
  "signatures": [
    {
      "index": 1,
      "pageStart": 1,
      "pageEnd": 8,
      "actualSheetCount": 2,
      "actualPageCount": 8,
      "blankPages": 0,
      "sheetCompensationMm": [0, 0.15],
      "sheets": [
        {
          "index": 1,
          "front": {
            "left": { "page": 8, "blank": false, "offsetMm": 0 },
            "right": { "page": 1, "blank": false, "offsetMm": 0 }
          },
          "back": {
            "left": { "page": 2, "blank": false, "offsetMm": 0, "backOf": 1 },
            "right": { "page": 7, "blank": false, "offsetMm": 0, "backOf": 8 }
          }
        },
        {
          "index": 2,
          "front": {
            "left": { "page": 6, "blank": false, "offsetMm": 0.15 },
            "right": { "page": 3, "blank": false, "offsetMm": -0.15 }
          }
        }
      ]
    }
  ]
}
```

启用适配检查时，每个页位对象增加 `fit`，例如：

```json
{
  "page": 8,
  "blank": false,
  "offsetMm": 0,
  "fit": {
    "ok": false,
    "rotation": 0,
    "rect": { "x": 0, "y": 0, "width": 220, "height": 310 },
    "trim": { "x": 5, "y": 6.5, "width": 210, "height": 297 },
    "bleedBox": { "x": 2, "y": 3.5, "width": 216, "height": 303 },
    "safeBox": { "x": 10, "y": 11.5, "width": 200, "height": 287 },
    "violations": [
      { "code": "bleed-overflow-left", "message": "左侧出血超出纸张 2mm（出血 5mm，含爬移偏移 0mm）" }
    ]
  }
}
```

顶层 `fit` 汇总：`{ enabled, paperWidth, paperHeight, pageWidth, pageHeight, bleedMm, safetyMm, slotWidth, slotHeight, ok, totalSlots, failCount }`；未启用时仅为 `{ "enabled": false }`。

启用试印核验时，顶层增加 `verification`：

- `observations`：规范化后的观察（含 1 起始序号 `index`）；
- `candidates`：四种「装订 × 翻转」候选，按「错误观察数 → 错误字段数 → 当前设置优先 → 固定组合顺序」排序，各含 `rank` / `isCurrent` / `tied` / `zeroDiff` / `wrongObservations` / `wrongFields` 与逐条比对 `details`（每条含 `observed` / `expected` / `pageMatch` / `orientationMatch`（`null` = 空白跳过）/ `wrongFields` / `match`）；
- `conclusion`：`status` 为 `verified`（唯一零差异，附 `combination` 与 `matchesCurrent`）/ `undetermined`（并列最优，附 `tied` 并列组合）/ `failed`（附最接近的 `best`），以及可读结论 `message`；
- `nextSuggestion`：**仅 `undetermined` 时计算**的下一处观察建议——`null` 表示无建议（所有未观察页位在并列组合下预期完全一致）；否则为 `{ signature, sheet, side, position, candidates, outcomeGroups, groupCount, worstRemainingCandidates }`（定位 + 各并列候选预期值 + 结果分组，详见上文「下一处观察建议」）；`verified` / `failed` 时恒为 `null`。

未启用核验时 `verification` 仅为 `{ "enabled": false }`。

参数非法时返回 `400` 与错误信息（含纸张厚度 / 最大补偿量为负，尺寸参数为负、非数字或只提供部分尺寸，`balancedSplit` / `chapterSplit` 非布尔值，两种分帖模式同时启用，章节起始页非数组 / 为空 / 非整数 / 重复 / 未递增 / 越界，观察记录非数组 / 超过 12 条 / 索引越界 / 重复观察 / 字段非法等情况）。另提供 `GET /api/health` 健康检查。

## 目录结构

```
├── server.js            # Express 服务：静态页面 + /api/impose
├── src/imposition.js    # 拼版计算核心（固定 / 均衡 / 章节优先分帖、正反面页位、翻转坐标变换、爬移补偿 offsetMm）
├── src/fitCheck.js      # 纸张规格与出血 / 安全区适配检查（可用矩形、trim/bleed/safe、超限原因）
├── src/verification.js  # 试印核验（观察校验、四种装订×翻转重算比对、候选排序与结论）
├── public/              # 前端（原生 Canvas 逐张绘制、原始/补偿页位叠加、适配标记、试印核验面板、JSON 导出）
│   ├── index.html
│   ├── app.js
│   └── style.css
├── test/imposition.test.js
├── test/fitCheck.test.js
├── test/chapterSplit.test.js
├── test/verification.test.js
├── test/api.test.js
├── Dockerfile
└── docker-compose.yml
```
