# Mooncakes 工具链兼容性扫描器

扫描近期发布的 Mooncakes 模块，使用本轮下载的 **stable（latest 渠道）** 和 **pre-release** 工具链分别运行 `moon check`，记录 stable 通过而 pre-release 失败的回归候选。

## 本地运行

需要 Linux x86_64 / aarch64、Node.js ≥22、npm、`git`、`tar`，以及访问 GitHub、mooncakes.io、download.mooncakes.io 和 cli.moonbitlang.com 的网络。

```bash
npm ci
npm run build
npm start -- --limit 3
```

完整扫描：

```bash
npm start
```

缩小复现范围（`--package` 仍受时间窗口限制，可以重复）：

```bash
npm start -- --days 30 --package moonbitlang/x --jobs 1 --timeout 300
```

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `--days` | `30` | 以启动时刻为基准，过去 N × 24 小时的 UTC 窗口，含两端 |
| `--jobs` | `2` | 同时处理的模块数；单模块先 stable 后 pre-release |
| `--timeout` | `300` | 每次 `moon check` 的限时，单位秒 |
| `--work-dir` | `.mooncakes-check` | 索引快照、工具链和工作副本目录 |
| `--output-dir` | `results` | 报告、日志和下载归档目录 |
| `--package` | 不限 | 精确模块名；找不到符合时间窗口的模块时报告错误 |
| `--limit` | 不限 | 按模块名字典序排序后，只检查前 N 个 |
| `--help` | — | 显示帮助 |

每轮有独立运行编号，目录参数会记录为绝对路径。不会覆盖上一次扫描结果，也不会修改已安装的 `~/.moon`。

## 筛选与检查规则

1. 浅克隆 `https://mooncakes.io/git/index` 的 `main`，记录提交号。本轮固定使用这份快照。
2. **缺少 `created_at` 的版本完全排除**：不参与时间窗口判断，也不参与最高版本选择。空字符串和 `null` 同样排除。其余非法时间、版本或校验和会记为索引错误。
3. 模块在时间窗口内至少有一次未撤回发布就入选，包括首次发布。随后从该模块具有有效时间、发布时间不晚于启动时刻的全部未撤回版本中选择最高 SemVer；这个最高版本可以早于时间窗口。SemVer 包含预发布版本。相同版本重复条目以最后一条有效记录为准。
4. 按 Moon registry 客户端的 URL 规则下载 ZIP，校验索引里的 SHA-256。每项网络下载和远程索引克隆最多尝试 3 次；单次下载限时 120 秒，克隆限时 120 秒。
5. ZIP 解压拒绝绝对路径、`..`、反斜杠、符号链接、特殊文件和重复条目，保留可执行位。限制为 100000 条目、解压后 2 GiB。支持根目录或唯一顶层包裹目录里的 `moon.mod` / `moon.mod.json`。
6. 每轮安装两个独立工具链以及各自渠道的 core，按官方安装器执行 core bundle，记录真实版本和下载归档的 SHA-256。安装单个子命令限时 300 秒。本轮不再更新工具链。
7. 同一 ZIP 解出两份独立源码，清除随包带入的 `.mooncakes`、`_build`、`target`。每个模块的每套工具链都有独立 `MOON_HOME`、依赖缓存、构建缓存和临时目录；清除继承的 MoonBit、编译器和缓存覆盖变量。
8. 每个检查目录独立复制本轮索引，将配置和 Git origin 都指向本地快照。即使 Moon 触发依赖索引刷新，也只能读到本轮提交。渠道内共享已安装的二进制和 core，其余缓存不共享。
9. 两边都执行 `moon check --warn-list=-a -j 1`，不指定 `--target`，保留模块自身的目标选择。stable 失败或超时后仍执行 pre-release，除非用户中断整轮扫描。

检查命令内部执行的依赖下载由 Moon 自己处理；若这些操作导致 `moon check` 非零退出，也会保留为检查失败。报告是**回归候选**，需要结合日志排除网络等非编译器原因。扫描器自己负责的下载、解压和进程启动错误则明确归为运行错误。

`moon check` 可能执行模块提供的构建脚本。这里的隔离针对源码、配置和缓存，不提供操作系统安全沙箱；建议在临时 CI runner 或容器中扫描。

## 报告、日志与退出码

每完成一个模块就原子替换 `report.json`，同时更新 `regressions.md`。JSON 包含配置、时间窗口、索引提交、工具链版本和哈希、源码 ZIP、所有模块状态，以及每次命令的输出日志路径、退出码、信号和耗时。

```text
results/<run-id>/
  report.json
  regressions.md
  sources/                 # 全部已下载的源码 ZIP
  toolchains/              # 两套发行包、core、安装元数据
  logs/                    # 索引、安装和逐模块 stdout/stderr
.mooncakes-check/<run-id>/
  index/                   # 固定索引及 Git 提交
  toolchains/              # 本轮安装的工具链
  packages/                # 只保留回归候选的两套工作副本
```

| 情况 | 分类 |
| --- | --- |
| stable 正常退出 0，pre-release 非零退出或自行被信号终止 | 回归候选 |
| 两边都通过、stable 不通过、两边都不通过 | 已检查，无回归候选 |
| 扫描器下载、校验、解压、启动或文件操作失败 | 运行错误 |
| 扫描器触发超时 | 运行错误，不计为回归 |
| SIGINT / SIGTERM | 保存已有结果，标记扫描不完整 |

超时或取消时先向整个子进程组发送 SIGTERM，1 秒后发送 SIGKILL，包括派生的编译器和构建脚本。完成后删除非回归模块的工作副本，保留全部日志、源码 ZIP、索引和工具链；清理失败也会记录为运行错误。`workDirs` 是运行时路径，只有 `retained: true` 时保证保留。

| 退出码 | 含义 |
| --- | --- |
| `0` | 完整扫描，无回归候选 |
| `1` | 完整扫描，存在回归候选 |
| `2` | 任何运行错误、索引错误或扫描未完成；优先于 `1` |

`complete` 表示是否完成本轮选中的所有模块，运行错误也算已尝试。某模块下载失败时可以 `complete: true` 且退出码为 `2`。使用 `--limit` 后的完整性仅针对受限集合。

## GitHub Actions

- 两个工作流均仅支持手动触发，push 和 pull request 不会自动运行。
- **Build and test**：到 **Actions → Build and test → Run workflow** 手动启动，在 Node.js 22 和 24 上执行 `npm ci`、构建和测试。测试通过后运行联网冒烟检查（三个真实包及 warning 样例），发现回归候选时上传单独的 `mooncakes-smoke-*` artifact。
- **Mooncakes compatibility scan**：到 **Actions → Mooncakes compatibility scan → Run workflow** 手动启动，默认运行完整的 30 天扫描，可设置 days、jobs、timeout、package、limit。
- 勾选 `smoke` 可执行联网冒烟验证：默认最多 3 个真实模块，再用两套真实工具链检查 warning 样例。`limit` 可以覆盖冒烟模式的默认数量。
- Actions Summary 显示选中数、完成数、两边通过数、回归数、运行错误和未完成数，并列出工具链版本及回归模块。
- 无论扫描成功或失败，都会汇总已有结果；只有发现回归候选时才上传 `mooncakes-scan-<run-id>-<attempt>` artifact，保存 14 天。扫描和冒烟工作流都只上传 `results/<run-id>/artifacts/`：`report.json` 仅包含回归候选的模块详情（`summary` 保留整轮统计）、`regressions.md`、回归模块的日志与源码 ZIP，以及 `reproduction.tar.gz`（本轮索引及回归模块工作目录）。不上传其他模块的数据、warning 样例文件、工具链安装日志、工具链/core 归档或工作目录中的工具链链接；工具链版本、下载 URL 和哈希仍记录在报告中。路径以报告记录的 runner 目录为准，复现时需要另行安装工具链，并相应调整工作目录和工具链链接。
- CI 在 320 分钟时向 CLI 发出 SIGTERM，给报告保存和产物上传留出时间；未扫描完的模块会保留为 pending。可用 `--package` 或 `--limit` 缩小范围。扫描退出码非零时工作流失败，整轮统计仍可在 Actions Summary 中查看，已发现的回归候选仍会上传。

已安装 GitHub CLI 时也可触发：

```bash
gh workflow run scan.yml --repo moonbit-community/mooncakes-check \
  -f days=30 -f jobs=2 -f timeout=300
```

## 验证

```bash
npm test
npm run smoke -- --limit 3
```

单元与集成测试使用 `node:test`、固定 JSON Lines 索引、生成的确定性 ZIP / tar 样本及模拟工具链，覆盖时间边界、SemVer、撤回和无时间版本、路径与校验失败、隔离、检查结果组合、进程崩溃/超时/启动失败、取消、单包失败后继续扫描、原子报告和 CI 统计。

测试不依赖外网。网络下载主要通过固定 fetch 响应测试；另有本地 HTTP 集成测试，在不允许监听端口的受限沙箱内会明确跳过，在 GitHub runner 上运行。真实的双工具链下载和 warning 样例验收使用 `npm run smoke`，需要联网 Linux。

实现依据：[Moon registry 客户端](https://github.com/moonbitlang/moon/blob/main/crates/mooncake/src/registry/client.rs)、[Moon registry 配置](https://github.com/moonbitlang/moon/blob/main/crates/moonutil/src/mooncakes.rs)、[官方 Unix 安装器](https://cli.moonbitlang.com/install/unix.sh)。
