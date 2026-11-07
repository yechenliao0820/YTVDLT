# YTVDLT · M1「骨架与引擎契约」汇报

> 汇报模板：HANDOFF §8 / PRD-M1 §8 ｜ 日期：2026-11-05 ｜ 交付方：寇豆码（Kou）· 工程师
> 权威输入：HANDOFF v1.1（933 行）> PRD-M1（348 行）> ARCHITECTURE-M1（1901 行）
> **本里程碑完成后停下等甲方放行，绝不推进 M2–M5。**

---

## 1. 完成了什么（对照 P0-01…P0-18 逐条）

| P0 | 结论 | 落地 |
|---|---|---|
| P0-01 | ✅ | 建 `ytvdlt/`，确认 Node v22.22.2 / npm 10.9.7 / Python 3.13.14，完整读三份权威文档 |
| P0-02 | ✅ | monorepo 骨架：`package.json` / `pnpm-workspace.yaml` / `turbo.json` / `tsconfig.base.json` / `.npmrc` / `.gitignore` / `vitest.config.ts`，4 个 workspace 包 + `scripts/` `tests/` `docs/` `resources/runtime/win-x64/` |
| P0-03 | ✅ | 分层铁律：`shared`/`core`/`engine-ytdlp` 的 tsconfig `"types": []`，`scripts/check-layering.mjs` + `tests/unit/layering.test.ts` 双守卫，**0 违规**；唯一 I/O 点 `node-ports.ts`，唯一 electron import 点 `runtime-resolver.ts` |
| P0-04 | ✅ | §6.4 全套 DTO：`ErrorCode` 恰 17 码、`DownloadEngine` 5 方法、`EngineEvent`/`Artifact`/`CancelHandle`/`MediaInfo`/`PlaylistInfo`/`DownloadRequest` 五域 / IPC channel 常量 / `CorePorts` 纯类型端口 |
| P0-05 | ✅ | `ConfigStore`：7 域 + `schemaVersion=1` + 纯函数迁移链 + 原子写 tmp→rename + 损坏回退默认并 WARNING（备份原文件不删用户数据） |
| P0-06 | ✅ | `Logger`：JSONL 结构化行 + `redactor` 12+ 类敏感键/argv option value/URL userinfo/Netscape cookies.txt 行全掩码 + 合规禁用项 `COMPLIANCE_BLOCKED` WARNING；崩溃报告/导出占位可用 |
| P0-07 | ✅ | `ErrorMapper`：**有序规则表首次命中**（429>403>DNS>超时>…），四类网络错误互斥；`report` 含 timestamp/OS/appVersion/engineVersion/code/URL/完整 stderr/argv 且全脱敏 |
| P0-08 | ✅ | `RuntimeResolver`：读 manifest → 逐文件 SHA-256+size → `--version` 探测 → 4 逻辑组 → `ENGINE_MISSING`/`JS_RUNTIME_MISSING`/`FFMPEG_MISSING` 专用码；不崩溃、不静默降级 |
| P0-09 | ✅ | `YtDlpEngine.probe()`：注入 `ProcessPort` spawn，绝对路径 + `argv[]` + `shell:false` + `windowsHide:true`，注入 `--no-js-runtimes --js-runtimes node:<内置 node.exe>`，stdout JSON → `JsonMapper` → `MediaInfo` |
| P0-10 | ✅ | `JsonMapper.toMediaInfo/toPlaylistInfo`：纯函数、guards 兜底、缺字段不抛异常、不触网不 spawn、字段完整映射 |
| P0-11 | ✅ | `ArgvBuilder.build(ProbeRequest)` 骨架（仅 probe 分支）：argv 顺序冻结、无字符串拼接、URL 白名单仅 http(s)、允许回环、拒 file:// / UNC / 盘符 / 内嵌凭据 / 控制字符；**probe 分支四维覆盖率 100%** |
| P0-12 | ✅ | `fetch-runtime.mjs`：`--only=ytdlp\|node\|ffmpeg` 分项下载、`SHA2-256SUMS` 官方交叉校验、zip 内置解压、原子放置、`--verify-only` 幂等复核、`--finalize` 生成 manifest |
| P0-13 | ✅ | `check-runtime.mjs` / `npm run check-runtime`：4 组输出版本 + 绝对路径；退出码 0/2/3；`--json` 写 `reports/check-runtime.json` |
| P0-14 | ✅ **最高优先** | **U3 = SUPPORTED**（B0 阶段后台下载、B1 结束前完成实测，见 DECISIONS §U3）：裸 exe probe 退出 0 且返回合法 JSON，真实下载含 FFmpeg 后处理成功，C1/C3/C4/C5/C6 全通过；结论与实测命令/输出已写入 `DECISIONS.md` |
| P0-15 | ✅ | §12.4 布局：`yt-dlp.exe` + `SHA2-256SUMS` + `node.exe` + `ffmpeg/`（整个 bin/ 原样，DLL 同目录）+ `FFMPEG-LICENSE.txt` + `runtime-manifest.json`（12 项，SHA-256 全项与磁盘一致）+ `runtime-manifest.schema.json` + `README.md` |
| P0-16 | ✅ | `electron-builder.yml` 含 `extraResources from: resources/runtime/win-x64 → to: runtime, filter **/*`；`files` 不含 runtime；`resolveRuntimeDir(env)` 用 `app.isPackaged` 切开发/打包双路径 |
| P0-17 | ✅ | L0（87 例）+ L1（含契约）+ L2（1 例 probe-local）+ fixtures；`npm test` 退出 0、零外网；`packages/core`+`engine-ytdlp` 覆盖率四维最低 **81.53% ≥70%**（多次运行区间 81.48–81.57%） |
| P0-18 | ✅ | 本汇报 + `reports/acceptance-report.json`（17 条断言 + 5 条验收）+ `DECISIONS.md` 定稿；矩阵项→断言 ID 稳定映射见 PRD-M1 §3（74 行） |

---

## 2. 改了哪些文件

**根配置（7）**：`package.json`、`pnpm-workspace.yaml`、`turbo.json`、`tsconfig.base.json`、`.npmrc`、`.gitignore`、`vitest.config.ts`

**`packages/shared/src/`（11）**：`index.ts`、`errors.ts`、`events.ts`、`media.ts`、`request.ts`、`runtime.ts`、`engine.ts`、`ipc.ts`、`ports.ts` + `package.json`/`tsconfig.json`

**`packages/core/src/`（17）**：`index.ts`、`ports.ts`、`config-store/{index,config-store,defaults,migrations}.ts`、`logger/{index,logger,redactor}.ts`、`error-mapper/{index,error-mapper,rules}.ts`、`runtime-resolver/{index,runtime-resolver,manifest-loader}.ts` + `package.json`/`tsconfig.json`

**`packages/engine-ytdlp/src/`（10）**：`index.ts`、`argv-builder.ts`、`json-mapper.ts`、`media-guards.ts`、`yt-dlp-engine.ts`、`fake-engine.ts`、`engine-factory.ts`、`probe-result.ts`、`runtime-check.ts` + `package.json`/`tsconfig.json`

**`apps/desktop/`（11）**：`package.json`、`tsconfig.json`、`electron-builder.yml`、`src/main/{index,app-host,ipc-gateway}.ts`（**空桩**）、`src/preload/bridge.ts`（**空桩**）、`src/main/runtime-resolver.ts`（唯一 electron import）、`src/main/adapters/node-ports.ts`（唯一 I/O 实现）、`src/main/runtime-paths.ts`、`src/main/README.md`

**`scripts/`（11）**：`fetch-runtime.mjs`、`check-runtime.mjs`、`u3-verify.mjs`、`check-layering.mjs`、`acceptance.mjs`、`run-tests.mjs`、`lib/{download,hash,zip,manifest,mock-server,verify-assets}.mjs`

**`resources/runtime/win-x64/`**：`yt-dlp.exe`、`SHA2-256SUMS`、`node.exe`、`ffmpeg/`（10 个文件）、`FFMPEG-LICENSE.txt`、`runtime-manifest.json`、`runtime-manifest.schema.json`、`README.md`

**`tests/`（23）**：`unit/`（9 个测试 + `helpers/in-memory-ports.ts`）、`contract/`（2）、`integration/`（1 + 2 helpers）、`fixtures/`（info-*.json ×3、config-*.json ×2、stderr-*.txt ×2、progress-basic.log、manifest.json、media/fixture.mp4、README.md）

**`docs/`（3 新建）**：`DECISIONS.md`、`M1-REPORT.md`（本文件）、`sequence-diagram.mermaid`、`class-diagram.mermaid`

> **未创建**：`packages/ui/**`（整包）、任何 `.tsx`/`.css`、窗口、托盘 UI、M2–M5 功能代码。
> **未修改**：`docs/PRD-M1.md`、`docs/ARCHITECTURE-M1.md`（只读引用）。

---

## 3. 如何运行

```bash
corepack enable && corepack prepare pnpm@9.15.9 --activate   # 实测 pnpm -v = 9.15.9
pnpm install                                                # 含 Electron 45.2.2
pnpm turbo run typecheck                                     # 4/4 包零错误
npm run check-runtime                                        # 4 组版本 + 绝对路径，退出 0
npm test                                                     # L0+L1，87 例，零外网，退出 0
```

运行时重建（二进制不入库）：

```bash
node scripts/fetch-runtime.mjs --only=ytdlp
node scripts/fetch-runtime.mjs --only=node
node scripts/fetch-runtime.mjs --only=ffmpeg
node scripts/fetch-runtime.mjs --finalize
```

---

## 4. 如何验收（命令 + 真实输出摘要）

| # | 命令 | 真实结果 |
|---|---|---|
| ① | `npm run check-runtime` | `ytdlp OK 2026.10.26` / `ffmpeg OK n9.0.2-47-gb204e94e90-20261104` / `node OK v24.22.2` / `aria2c OPTIONAL`；`allRequiredOk=true summary={requiredOk:3,requiredTotal:3,optionalMissing:1,failed:0}`；退出 **0** |
| ①-负向 | 临时移走 `node.exe` → `node scripts/check-runtime.mjs --json` | `node.status=MISSING`、`errorCode=JS_RUNTIME_MISSING`、`allRequiredOk=false`、退出 **2**、不崩溃；移回复验退出 **0** |
| ② | `npm run test:contract` | `tests/contract/json-mapper.contract.test.ts` 5 例全绿，fixture 字段/类型 0 FAIL、不触网不 spawn |
| ③ | `npm run test:integration:offline -- --case probe-local` | 真实 `YtDlpEngine.probe()` 对 `http://127.0.0.1:<port>/fixture.mp4` 退出 0，返回完整 `MediaInfo`；spawn 绝对路径 + `argv[]` + `shell:false` + `windowsHide:true`；1 例 PASS |
| ④ | `npm run test:unit -- --run ArgvBuilder --coverage`（**定向**，按测试文件名匹配 `tests/unit/argv-builder.test.ts`，覆盖率范围收窄到 `packages/engine-ytdlp/src/argv-builder.ts`） | **15 passed / 0 skipped**（1 test file）；`argv-builder.ts` **lines 100% / branches 100% / functions 100% / statements 100%** |
| ④-补充 | `npm test`（`run-tests.mjs all --coverage`，L0+L1 全量） | 11 文件 **87/87** 全绿、退出 0；四维 **lines 93.71% / branches 81.33% / functions 92.70% / statements 93.71%**（最低 81.33% ≥70%） |
| ⑤ | `pnpm exec vitest run --coverage`（**全量**，含 L2 integration） | 12 文件 88 例全绿；`coverage/coverage-summary.json` 四维：**lines 93.71%、branches 81.53%、functions 92.70%、statements 93.71%**，最低 81.53% **≥70%**；`argv-builder.ts` 在该全量运行下同样 **100/100/100/100** |
| — | `node scripts/check-layering.mjs` | `0 violations (packages/shared/src, packages/core/src, packages/engine-ytdlp/src)` |
| — | `node scripts/u3-verify.mjs --json > reports/u3.json` | `conclusion=SUPPORTED`，probe exit 0、download exit 0、U8 `--ffmpeg-location=true` |
| — | `node scripts/lib/verify-assets.mjs` | `extraResourcesOk=true`、`filesExcludesRuntime=true`、manifest 12 项 SHA+size 全 OK、官方 SUMS 交叉一致 |
| — | `node scripts/acceptance.mjs --milestone M1` | 生成 `reports/acceptance-report.json`：17 条断言 + 5 条验收 |

**验收报告**：`reports/acceptance-report.json`（每项 `id/layer/status/expected/actual/durationMs/evidence`）

---

## 5. 矩阵项 → 断言 ID 对照表（17 条「M1 必须绿」）

> 完整 74 行全表在 `docs/PRD-M1.md` §3（**稳定不改号**）。M1 只判以下 17 条。

| 断言 ID | 层 | 承载 | 结果 |
|---|---|---|---|
| A-4.1-03 | L0 | `config-store.test.ts` saved_links 重启保持 + 损坏回退 WARNING | **PASS** |
| A-4.1-04 | L1 | `json-mapper.contract.test.ts` / `json-mapper.test.ts` 字段齐全类型正确 | **PASS** |
| A-4.4-19 | L0 | `config-store.test.ts` 分域/schemaVersion/迁移/原子写 | **PASS** |
| A-4.4-30 | L0 | `logger.test.ts` JSONL + 12 类敏感键全掩码 | **PASS** |
| A-4.5-03 | L0 | `error-mapper.test.ts` `example.invalid` → `UNSUPPORTED_SITE` | **PASS** |
| A-4.5-05 | L0 | `error-mapper.test.ts` 超时/DNS/403/429 四类互斥（有序首次命中） | **PASS** |
| A-4.5-09 | L0 | `error-mapper.test.ts` + `logger.test.ts` report 全字段且脱敏 | **PASS** |
| A-INF-01 | L0 | `shared-contract.test.ts` + `layering.test.ts` + workspace 4 包 | **PASS** |
| A-INF-02 | L4-packaging(前置) | `runtime-manifest.json` + `extraResources` + `verify-assets.mjs` | **PASS** |
| A-INF-03 | L2 | `u3-verify.mjs` → `SUPPORTED` + DECISIONS | **PASS** |
| A-INF-04 | L0 | `check-runtime.mjs` 4 组 + 负向 `JS_RUNTIME_MISSING` 退出 2 | **PASS** |
| A-INF-05 | L0 | `argv-builder.test.ts` argv 顺序 + URL 白名单 + probe 分支 100% | **PASS** |
| A-INF-06 | L0 | `coverage/coverage-summary.json` 四维最低 81.53% + `npm test` 退出 0 | **PASS** |
| A-INF-07 | L2 | `probe-local.test.ts` 真实 `probe()` 完整 `MediaInfo` | **PASS** |
| A-INF-08 | L1 | `json-mapper.contract.test.ts` 录制 fixture 全绿、不触网不 spawn | **PASS** |
| A-INF-09 | L0 | 本汇报 + `acceptance-report.json` + `DECISIONS.md` + 停下声明 | **PASS** |
| A-INF-10 | L1 | `download-engine.contract.test.ts` 5 方法 + `FakeEngine` 同接口 | **PASS** |

**§8 M1 五条验收**：① check-runtime ② JsonMapper fixture ③ probe() 本地直链 ④ ArgvBuilder probe 分支 ⑤ 覆盖率 —— 全部可判定为 **PASS**。

---

## 6. 剩余 / 阻塞 / 偏离（详见 `DECISIONS.md`）

| 项 | 说明 |
|---|---|
| U3 结论 | **SUPPORTED**：L2 走真实 `YtDlpEngine.probe()`，`FakeEngine` 仅用于证明引擎可替换（A-INF-10），不启用降级 |
| Q-01 覆盖率口径 | M1 按 §8 取 ≥70%（实测 81.53%）；M2–M5 逐模块补测收敛到 §7.1 的 ≥80% |
| pnpm 补齐 | corepack 方案 A，实测 9.15.9；未更换包管理器 |
| 断言 ID | 17 条不改号，后续只追加/细化 |
| 二进制不入库 | `.gitignore` 忽略 exe/DLL/zip；`fetch-runtime.mjs --verify-only` 幂等重建 |
| `latest` tag | 采用 BtbN `latest` n9.0 稳定线，manifest 记录实际解析到的 asset + published_at = `2026-11-04T13:18:35Z`；脚本内置固定 autobuild 备选 |
| U3 顺序调整 | D-01：B0 后台下载、B1 结束前完成 U3（HANDOFF §10 Step 1 优先于架构 B3 排序） |
| 许可证实测 | D-08：BtbN LGPL 构建实际随包 `LICENSE.txt` 为 **LGPLv3**（非文档假设的 LGPL-2.1+）；manifest `license=LGPL-3.0`，M5 需按实际文本复核 §12.5 文案 |
| 编码器 | D-09：LGPL 构建无 `libx264` 但有 `libopenh264` → 采用方案 A 生成真实 H.264+AAC 10s fixture，无需降级 |
| U8 | `--ffmpeg-location` 实测**支持**；同时保留 PATH 前置兜底 |
| 已知观察项 | U1/U4/U5/U7（M2/M5 实测）、`aria2c` 仅 OPTIONAL 不捆绑、`DownloadEngine` 其余 3 方法为 M1 `UNKNOWN` 占位 |
| 阻塞 | **无**。六批验证命令全部真实跑通 |

---

## 7. 停下声明

**M1 汇报完成，停下等甲方放行，未获甲方放行，不进入 M2。**
本次交付不含任何 UI、任何窗口、任何 M2–M5 功能代码；`packages/ui/**` 不存在。

---

*文档结束 · YTVDLT M1 汇报 · 未获甲方放行，不进入 M2*
