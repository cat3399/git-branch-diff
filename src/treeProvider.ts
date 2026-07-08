import * as vscode from "vscode";
import * as path from "path";
import {
  FileChange,
  ChangeStatus,
  getCurrentBranch,
  getMergeBase,
  listChanges,
  listWorkingChanges,
} from "./git";

const TARGET_KEY = "branchDiff.target";
const SOURCE_KEY = "branchDiff.source";

/** Sentinel source ref meaning "the currently checked-out branch". */
export const HEAD_SOURCE = "HEAD";

/** Sentinel source meaning "the working tree" (uncommitted changes). */
export const WORKTREE_SOURCE = "~worktree";

const STATUS_LABEL: Record<ChangeStatus, string> = {
  A: "Added",
  M: "Modified",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  T: "Type changed",
  U: "Unmerged",
};

/** Theme color used for each status's letter badge, mirroring VS Code's git view. */
const STATUS_COLOR: Record<ChangeStatus, string> = {
  A: "gitDecoration.addedResourceForeground",
  M: "gitDecoration.modifiedResourceForeground",
  D: "gitDecoration.deletedResourceForeground",
  R: "gitDecoration.renamedResourceForeground",
  C: "gitDecoration.renamedResourceForeground",
  T: "gitDecoration.modifiedResourceForeground",
  U: "gitDecoration.conflictingResourceForeground",
};

/**
 * Custom scheme for a changed-file item's resourceUri. Using a dedicated scheme
 * lets the FileDecorationProvider add status badges to our view WITHOUT leaking
 * those decorations onto the same files in the Explorer or editor tabs. The path
 * keeps the real filename so the file-icon theme still renders the correct icon.
 */
export const STATUS_SCHEME = "branchdiff-status";

/** Short per-file stats string, e.g. "+12 −3", "binary", or "" when unknown. */
function formatStats(change: FileChange): string {
  if (change.binary) {
    return "binary";
  }
  if (change.additions === undefined && change.deletions === undefined) {
    return "";
  }
  const parts: string[] = [];
  if (change.additions) {
    parts.push(`+${change.additions}`);
  }
  if (change.deletions) {
    parts.push(`−${change.deletions}`);
  }
  return parts.join(" ");
}

function makeStatusUri(change: FileChange): vscode.Uri {
  return vscode.Uri.from({
    scheme: STATUS_SCHEME,
    path: "/" + change.path,
    query: change.status,
  });
}

/** Payload carried by a file item and handed to the openChange command. */
export interface ChangePayload {
  repoRoot: string;
  /** Diff base ref (merge-base sha or target branch name) — the "before" side. */
  base: string;
  /** Source ref (branch name or HEAD) — the "after" side. */
  source: string;
  /** Human-friendly source name for diff titles. */
  sourceLabel: string;
  /** Human-friendly target (base) name for diff titles. */
  targetLabel: string;
  change: FileChange;
}

/** Shared context passed to the tree builders. */
interface BuildContext {
  repoRoot: string;
  base: string;
  source: string;
  sourceLabel: string;
  targetLabel: string;
}

/** A file-tree node — either a folder or a changed file. */
export type BranchDiffNode = FolderItem | ChangeItem;

/** Any node the provider can render, including the top-level repo header. */
export type TreeNode = RepoItem | BranchDiffNode;

/** Top-level header shown per repository when the workspace has several. */
export class RepoItem extends vscode.TreeItem {
  constructor(readonly session: RepoSession) {
    super(
      path.basename(session.repoRoot) || session.repoRoot,
      vscode.TreeItemCollapsibleState.Expanded
    );
    this.id = session.repoRoot;
    this.contextValue = "branchDiffRepo";
    this.iconPath = new vscode.ThemeIcon("repo");
    this.tooltip = session.repoRoot;
    this.description = session.target
      ? `${session.sourceLabel} → ${session.target}` +
        (session.fileCount ? `  (${session.fileCount})` : "")
      : "No target selected";
  }
}

export class FolderItem extends vscode.TreeItem {
  children: BranchDiffNode[] = [];

  constructor(
    /** Display segment (may span several levels when folders are compacted). */
    label: string,
    /** Full folder path relative to the repo root. */
    readonly relPath: string,
    readonly repoRoot: string
  ) {
    super(label, vscode.TreeItemCollapsibleState.Expanded);
    this.resourceUri = vscode.Uri.file(path.join(repoRoot, relPath));
    this.contextValue = "branchDiffFolder";
    // Let VS Code render the themed folder icon based on resourceUri.
    this.iconPath = vscode.ThemeIcon.Folder;
  }
}

export class ChangeItem extends vscode.TreeItem {
  readonly payload: ChangePayload;

  constructor(
    ctx: BuildContext,
    change: FileChange,
    /** Show the directory as the item description (used in flat mode). */
    showDir: boolean
  ) {
    super(path.basename(change.path), vscode.TreeItemCollapsibleState.None);
    this.payload = {
      repoRoot: ctx.repoRoot,
      base: ctx.base,
      source: ctx.source,
      sourceLabel: ctx.sourceLabel,
      targetLabel: ctx.targetLabel,
      change,
    };

    // Description shows the +/- line counts; in flat mode the directory is
    // prepended since the tree hierarchy isn't there to convey it.
    const dir = path.dirname(change.path);
    const stats = formatStats(change);
    if (showDir && dir !== ".") {
      this.description = stats ? `${dir} · ${stats}` : dir;
    } else {
      this.description = stats || undefined;
    }

    // A custom-scheme URI drives both the file-type icon (via the filename in
    // the path) and the status badge (via the FileDecorationProvider).
    this.resourceUri = makeStatusUri(change);

    const statusName = STATUS_LABEL[change.status] ?? change.status;
    this.tooltip =
      change.status === "R" && change.oldPath
        ? `${statusName}: ${change.oldPath} → ${change.path}`
        : `${statusName}: ${change.path}`;

    this.contextValue = "branchDiffChange";

    this.command = {
      command: "branchDiff.openChange",
      title: "Open Change",
      arguments: [this.payload],
    };
  }
}

/**
 * Adds the colored status letter (M / A / D / R …) to the right of each file,
 * matching VS Code's Source Control view. Only decorates our custom scheme, so
 * the same files are untouched elsewhere in the workbench.
 */
export class StatusDecorationProvider
  implements vscode.FileDecorationProvider
{
  provideFileDecoration(
    uri: vscode.Uri
  ): vscode.ProviderResult<vscode.FileDecoration> {
    if (uri.scheme !== STATUS_SCHEME) {
      return undefined;
    }
    const status = uri.query as ChangeStatus;
    return {
      badge: status,
      color: new vscode.ThemeColor(
        STATUS_COLOR[status] ?? "gitDecoration.modifiedResourceForeground"
      ),
      tooltip: STATUS_LABEL[status] ?? status,
    };
  }
}

/** Mutable intermediate folder used while building the tree from flat paths. */
interface RawFolder {
  name: string;
  path: string;
  folders: Map<string, RawFolder>;
  files: FileChange[];
}

function newRawFolder(name: string, folderPath: string): RawFolder {
  return { name, path: folderPath, folders: new Map(), files: [] };
}

/** Insert a change into the raw folder tree at its directory path. */
function insertChange(root: RawFolder, change: FileChange): void {
  const dir = path.dirname(change.path);
  if (dir === ".") {
    root.files.push(change);
    return;
  }
  let cur = root;
  let acc = "";
  for (const segment of dir.split("/")) {
    acc = acc ? `${acc}/${segment}` : segment;
    let next = cur.folders.get(segment);
    if (!next) {
      next = newRawFolder(segment, acc);
      cur.folders.set(segment, next);
    }
    cur = next;
  }
  cur.files.push(change);
}

/**
 * Collapse a chain of single-child folders (e.g. `src/main/java`) into one node,
 * mirroring VS Code's "compact folders" explorer behavior.
 */
function compactAndConvert(raw: RawFolder, ctx: BuildContext): FolderItem {
  let label = raw.name;
  let cur = raw;
  while (cur.folders.size === 1 && cur.files.length === 0) {
    const only = cur.folders.values().next().value as RawFolder;
    label = `${label}/${only.name}`;
    cur = only;
  }
  const item = new FolderItem(label, cur.path, ctx.repoRoot);
  item.children = buildChildren(cur, ctx);
  return item;
}

/** Folders first (alphabetical), then files (alphabetical by name). */
function buildChildren(raw: RawFolder, ctx: BuildContext): BranchDiffNode[] {
  const folders = [...raw.folders.values()]
    .map((f) => compactAndConvert(f, ctx))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));

  const files = raw.files
    .map((change) => new ChangeItem(ctx, change, false))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));

  return [...folders, ...files];
}

/**
 * One repository's comparison: its remembered source/target, computed change
 * tree, and stats. State is persisted per repo under `<key>:<repoRoot>`.
 */
export class RepoSession {
  roots: BranchDiffNode[] = [];
  fileCount = 0;
  additions = 0;
  deletions = 0;
  summary = "";
  private error: string | undefined;

  constructor(
    readonly repoRoot: string,
    /** Name of the checked-out branch, used to label the default HEAD source. */
    readonly currentBranch: string,
    private readonly context: vscode.ExtensionContext,
    /** Called after each refresh so the coordinator can redraw the tree. */
    private readonly onChanged: () => void
  ) {}

  private key(base: string): string {
    return `${base}:${this.repoRoot}`;
  }

  get target(): string | undefined {
    return this.context.workspaceState.get<string>(this.key(TARGET_KEY));
  }

  /** Source ref; defaults to HEAD (the checked-out branch). */
  get source(): string {
    return (
      this.context.workspaceState.get<string>(this.key(SOURCE_KEY)) ??
      HEAD_SOURCE
    );
  }

  /** Display name for the current source ref. */
  get sourceLabel(): string {
    const s = this.source;
    if (s === WORKTREE_SOURCE) {
      return "Working Tree";
    }
    return s === HEAD_SOURCE ? this.currentBranch || "current" : s;
  }

  async setTarget(target: string): Promise<void> {
    await this.context.workspaceState.update(this.key(TARGET_KEY), target);
    await this.refresh();
  }

  async setSource(source: string): Promise<void> {
    await this.context.workspaceState.update(this.key(SOURCE_KEY), source);
    await this.refresh();
  }

  /** Set both source and target together (one refresh) — used by swap. */
  async setComparison(source: string, target: string): Promise<void> {
    await this.context.workspaceState.update(this.key(SOURCE_KEY), source);
    await this.context.workspaceState.update(this.key(TARGET_KEY), target);
    await this.refresh();
  }

  private reset(): void {
    this.roots = [];
    this.fileCount = 0;
    this.additions = 0;
    this.deletions = 0;
    this.summary = "";
  }

  async refresh(): Promise<void> {
    const target = this.target;
    this.error = undefined;

    if (!target) {
      this.reset();
      this.onChanged();
      return;
    }

    try {
      const config = vscode.workspace.getConfiguration("branchDiff");
      const useMergeBase = config.get<boolean>("useMergeBase", true);
      const groupByFolder = config.get<boolean>("groupByFolder", true);
      const includeUntracked = config.get<boolean>("includeUntracked", true);

      const source = this.source;
      const isWorktree = source === WORKTREE_SOURCE;
      // The working tree sits on HEAD, so use HEAD for the merge-base.
      const gitSource = isWorktree ? HEAD_SOURCE : source;

      const base = useMergeBase
        ? await getMergeBase(this.repoRoot, gitSource, target)
        : target;

      const changes = isWorktree
        ? await listWorkingChanges(this.repoRoot, base, includeUntracked)
        : await listChanges(this.repoRoot, base, gitSource);

      this.fileCount = changes.length;
      this.additions = changes.reduce((n, c) => n + (c.additions ?? 0), 0);
      this.deletions = changes.reduce((n, c) => n + (c.deletions ?? 0), 0);
      this.summary = summarize(changes);

      const ctx: BuildContext = {
        repoRoot: this.repoRoot,
        base,
        source,
        sourceLabel: this.sourceLabel,
        targetLabel: target,
      };

      if (groupByFolder) {
        const root = newRawFolder("", "");
        for (const change of changes) {
          insertChange(root, change);
        }
        this.roots = buildChildren(root, ctx);
      } else {
        this.roots = changes.map((change) => new ChangeItem(ctx, change, true));
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.reset();
      vscode.window.showErrorMessage(
        `Branch Diff (${path.basename(this.repoRoot)}): ${this.error}`
      );
    }

    this.onChanged();
  }
}

/**
 * Tree data provider coordinating one {@link RepoSession} per repository. With
 * a single repo the file tree is shown flat; with several, each repo gets a
 * collapsible {@link RepoItem} header.
 */
export class ChangedFilesProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<
    TreeNode | undefined | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly sessions = new Map<string, RepoSession>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Migrate a pre-multi-repo (unkeyed) selection onto `repoRoot`, once. */
  async migrateLegacy(repoRoot: string): Promise<void> {
    const state = this.context.workspaceState;
    const legacyTarget = state.get<string>(TARGET_KEY);
    if (legacyTarget === undefined) {
      return;
    }
    const perRepoTarget = `${TARGET_KEY}:${repoRoot}`;
    if (state.get<string>(perRepoTarget) === undefined) {
      await state.update(perRepoTarget, legacyTarget);
      const legacySource = state.get<string>(SOURCE_KEY);
      if (legacySource !== undefined) {
        await state.update(`${SOURCE_KEY}:${repoRoot}`, legacySource);
      }
    }
    await state.update(TARGET_KEY, undefined);
    await state.update(SOURCE_KEY, undefined);
  }

  /** Reconcile the session map with the discovered repository roots. */
  async setRepos(roots: string[]): Promise<void> {
    for (const root of [...this.sessions.keys()]) {
      if (!roots.includes(root)) {
        this.sessions.delete(root);
      }
    }
    for (const root of roots) {
      if (!this.sessions.has(root)) {
        const currentBranch = await getCurrentBranch(root).catch(() => "");
        this.sessions.set(
          root,
          new RepoSession(root, currentBranch, this.context, () =>
            this._onDidChangeTreeData.fire()
          )
        );
      }
    }
    await this.refreshAll();
  }

  get repoCount(): number {
    return this.sessions.size;
  }

  sessionList(): RepoSession[] {
    return [...this.sessions.values()].sort((a, b) =>
      a.repoRoot.localeCompare(b.repoRoot)
    );
  }

  getSession(root: string): RepoSession | undefined {
    return this.sessions.get(root);
  }

  /** Total changed files across all repos. */
  get totalFileCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      n += s.fileCount;
    }
    return n;
  }

  /** Aggregate summary line (per-repo when only one repo is present). */
  get summary(): string {
    const sessions = this.sessionList();
    if (sessions.length <= 1) {
      return sessions[0]?.summary ?? "";
    }
    let files = 0;
    let add = 0;
    let del = 0;
    let anyTarget = false;
    for (const s of sessions) {
      files += s.fileCount;
      add += s.additions;
      del += s.deletions;
      anyTarget = anyTarget || Boolean(s.target);
    }
    if (!anyTarget) {
      return "";
    }
    if (files === 0) {
      return `No changes · ${sessions.length} repos`;
    }
    const counts: string[] = [];
    if (add) {
      counts.push(`+${add}`);
    }
    if (del) {
      counts.push(`−${del}`);
    }
    const c = counts.length ? ` · ${counts.join(" ")}` : "";
    return `${files} file${files === 1 ? "" : "s"} changed${c} · ${sessions.length} repos`;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const sessions = this.sessionList();
      if (sessions.length === 1) {
        return sessions[0].roots;
      }
      return sessions.map((s) => new RepoItem(s));
    }
    if (element instanceof RepoItem) {
      return element.session.roots;
    }
    if (element instanceof FolderItem) {
      return element.children;
    }
    return [];
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.sessionList().map((s) => s.refresh()));
    // Redraw even when there are zero sessions.
    this._onDidChangeTreeData.fire();
  }
}

/** Build a "N files changed · +A −D" summary from the change list. */
function summarize(changes: FileChange[]): string {
  if (changes.length === 0) {
    return "No changes";
  }
  let add = 0;
  let del = 0;
  for (const c of changes) {
    add += c.additions ?? 0;
    del += c.deletions ?? 0;
  }
  const files = `${changes.length} file${changes.length === 1 ? "" : "s"} changed`;
  const counts: string[] = [];
  if (add) {
    counts.push(`+${add}`);
  }
  if (del) {
    counts.push(`−${del}`);
  }
  return counts.length ? `${files} · ${counts.join(" ")}` : files;
}
