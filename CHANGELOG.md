# Changelog

All notable changes to the Branch Diff extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-09（本地版）

- 两侧原生选择器支持“分支 → 最新提交 / 历史提交”，历史列表按分支筛选，分页期间固定历史起点，并提供逐级返回。
- 从分支历史选择的提交保留分支名称和固定 SHA；选择最新提交时持续跟随分支。
- 原生更多菜单新增“比较方式…”，按仓库保存直接比较或从共同祖先比较（PR）。
- 顶部显示实际参与比较的 SHA，PR 模式及原生 Diff 标题标明共同祖先；没有共同祖先时明确提示。

## [0.2.2] - 2026-09-08（本地版）

- “本次比较中排除”和“恢复本次排除项”与复制路径等文件操作放在同一右键菜单分组，取消它们之间的分隔线。

## [0.2.1] - 2026-09-08（本地版）

- 文件和目录的原生右键菜单新增“本次比较中排除”，同步更新可见文件和行数统计。
- 提供“恢复本次排除项”。排除只保存在内存中，普通刷新保留，切换比较对象或重新加载窗口后清空。

## [0.2.0] - 2026-09-08（本地版）

- 两侧都可选择提交、暂存区和工作区，支持交换方向及常用比较快捷命令。
- 增加提交浏览与分页，以及简体中文命令、提示和配置说明。
- 文件名独立于 Git 状态着色，新增行数绿色、删除行数红色。
- 目录行数在悬停时行内显示，包含所有子目录的累计变化。
- 版本选择、交换和刷新使用 VS Code 原生视图工具栏，文件图标复用当前主题和官方 Codicons。
- 默认直接比较选定版本；暂存区读取真实索引内容，保存或 Git 状态变化后自动刷新。
- 修正带制表符的路径统计，以及文件从索引移除后仍存在于工作区的比较。
- 本地版使用独立扩展 ID 和配置前缀。

## [0.1.3] - 2026-07-08

### Fixed

- Use a direct `raw.githubusercontent.com` URL for the README image so it loads
  reliably on the Marketplace listing (the auto-rewritten `github.com/.../raw`
  URL was rate-limited and intermittently failed).

## [0.1.2] - 2026-07-08

### Fixed

- Icon now has transparent rounded corners instead of a white background, so it
  renders as a proper rounded tile on both light and dark themes.

## [0.1.1] - 2026-07-08

### Fixed

- Corrected the repository, homepage, and issues URLs to the `git-branch-diff`
  repo, fixing the broken listing image on the Marketplace.

## [0.1.0] - 2026-07-08

First public release.

### Added

- **Changed Files sidebar** in the Activity Bar listing every file that differs
  between a source and target, with **colored status badges** (A / M / D / R …)
  matching VS Code's Source Control view, per-file `+/−` line counts, a
  "N files changed · +A −B" summary, and a changed-file count badge.
- **Pick both sides** — compare any **source** against any **target**: a branch,
  remote branch, tag, arbitrary commit / ref (validated), or the **Working Tree**
  (staged, unstaged, and untracked uncommitted changes) as the source.
- **Swap** command and title-bar button to flip source ↔ target.
- **Multi-repository support** — each git repo in the workspace (discovered via
  the built-in Git extension) gets its own header and independent comparison.
- **Native side-by-side diff** opened by clicking any file, backed by a
  `branchdiff:` content provider that serves file contents at any git ref. The
  Working Tree source opens against the live, editable file.
- **Merge-base (3-dot) comparison** by default (like a GitHub PR), with the
  `branchDiff.useMergeBase` setting to switch to a direct 2-dot comparison.
- **Folder-tree grouping** with compacted single-child folders
  (`branchDiff.groupByFolder`).
- **File-row context menu** — Open File, Open to the Side, Copy Path, Copy
  Relative Path, Reveal in Explorer.
- **Diff line actions** — right-click a line to Open File at This Line, Copy Line
  Reference (`path:line`), or Copy Line.
- Source and target selections are remembered per repo, per workspace.
- Unit tests for the git output parsers; CI and a tagged-release workflow that
  packages a `.vsix`.

[0.1.3]: https://github.com/firdaushatta/git-branch-diff/releases/tag/v0.1.3
[0.1.2]: https://github.com/firdaushatta/git-branch-diff/releases/tag/v0.1.2
[0.1.1]: https://github.com/firdaushatta/git-branch-diff/releases/tag/v0.1.1
[0.1.0]: https://github.com/firdaushatta/git-branch-diff/releases/tag/v0.1.0
