# Changelog

All notable changes to the Branch Diff extension are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.2]: https://github.com/firdaushatta/git-branch-diff/releases/tag/v0.1.2
[0.1.1]: https://github.com/firdaushatta/git-branch-diff/releases/tag/v0.1.1
[0.1.0]: https://github.com/firdaushatta/git-branch-diff/releases/tag/v0.1.0
