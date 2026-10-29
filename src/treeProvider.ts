import * as vscode from "vscode";
import * as path from "path";
import { compareRefs, FileChange, getCurrentBranch, HEAD_REF, isLiveRef, NoMergeBaseError } from "./git";
import { buildFileTree, ChangeTotals, FileTreeEntry } from "./fileTree";
import { refLabel, RefSelection } from "./refPicker";

const TARGET_KEY = "branchDiffLocal.target";
const SOURCE_KEY = "branchDiffLocal.source";
const MODE_KEY = "branchDiffLocal.useMergeBase";

export interface ChangePayload {
  repoRoot: string;
  base: string;
  source: string;
  sourceLabel: string;
  targetLabel: string;
  change: FileChange;
}

const emptyTotals = (): ChangeTotals => ({
  files: 0, additions: 0, deletions: 0, binaries: 0,
});

export function formatSummary(totals: ChangeTotals): string {
  if (!totals.files) return vscode.l10n.t("No changes");
  const files = vscode.l10n.t("{0} files changed", totals.files);
  const binaries = totals.binaries
    ? " · " + vscode.l10n.t("{0} binary files", totals.binaries)
    : "";
  return `${files}${binaries}`;
}

/** One repository's selected endpoints and the latest completed comparison. */
export class RepoSession {
  roots: FileTreeEntry[] = [];
  totals = emptyTotals();
  currentBranch = "";
  error: string | undefined;
  loading = false;
  private generation = 0;
  private comparison: {
    target: string; base: string; source: string; mergeBase?: string;
    targetLabel: string; sourceLabel: string; selectedTargetLabel: string;
  } | undefined;
  private readonly changes = new Map<string, FileChange>();
  private readonly excludedPaths = new Map<string, FileTreeEntry["kind"]>();

  constructor(
    readonly repoRoot: string,
    private readonly context: vscode.ExtensionContext,
    private readonly onChanged: () => void
  ) {}

  private key(base: string): string {
    return `${base}:${this.repoRoot}`;
  }

  private readSelection(key: string): RefSelection | undefined {
    const saved = this.context.workspaceState.get<string | RefSelection>(this.key(key));
    return typeof saved === "string" ? { ref: saved } : saved;
  }

  get target(): RefSelection | undefined {
    return this.readSelection(TARGET_KEY);
  }

  get source(): RefSelection {
    return this.readSelection(SOURCE_KEY) ?? { ref: HEAD_REF };
  }

  get sourceLabel(): string {
    const source = this.source;
    return refLabel(source.ref, this.currentBranch, source.branch);
  }

  get targetLabel(): string {
    const target = this.target;
    return target
      ? refLabel(target.ref, this.currentBranch, target.branch)
      : vscode.l10n.t("Select base");
  }

  get useMergeBase(): boolean {
    return this.context.workspaceState.get<boolean>(this.key(MODE_KEY))
      ?? vscode.workspace.getConfiguration("branchDiffLocal", vscode.Uri.file(this.repoRoot)).get<boolean>("useMergeBase", false);
  }

  get comparisonLabel(): string {
    if (this.loading || !this.comparison) return "";
    const { base, source, mergeBase } = this.comparison;
    const left = mergeBase ? vscode.l10n.t("Merge base {0}", base.slice(0, 8)) : refLabel(base);
    return `${mergeBase ? "PR" : vscode.l10n.t("Direct")} · ${left} → ${refLabel(source)}`;
  }

  get comparisonDetails(): string {
    if (this.loading || !this.comparison) return "";
    const result = this.comparison;
    return [
      vscode.l10n.t("Selected base: {0}", `${result.selectedTargetLabel} (${isLiveRef(result.target) ? refLabel(result.target) : result.target})`),
      vscode.l10n.t("Selected comparison: {0}", `${result.sourceLabel} (${isLiveRef(result.source) ? refLabel(result.source) : result.source})`),
      vscode.l10n.t("Actual base: {0}", isLiveRef(result.base) ? refLabel(result.base) : result.base),
    ].join("\n");
  }

  get summary(): string {
    if (!this.target) return "";
    const excluded = this.changes.size - this.totals.files;
    if (!excluded) return formatSummary(this.totals);
    if (!this.totals.files) return vscode.l10n.t("All {0} changed files excluded", excluded);
    return formatSummary(this.totals) + " · " + vscode.l10n.t("{0} files excluded", excluded);
  }

  get hasExclusions(): boolean {
    return this.excludedPaths.size > 0;
  }

  excludeEntries(entries: FileTreeEntry[]): void {
    if (this.loading || !entries.length) return;
    for (const entry of entries) this.excludedPaths.set(entry.path, entry.kind);
    this.rebuildTree();
    this.onChanged();
  }

  restoreExcluded(): void {
    this.excludedPaths.clear();
    this.rebuildTree();
    this.onChanged();
  }

  private rebuildTree(): void {
    const folders = [...this.excludedPaths].filter(([, kind]) => kind === "folder").map(([folder]) => folder + "/");
    const visible = [...this.changes.values()].filter((change) =>
      !this.excludedPaths.has(change.path) && !folders.some((folder) => change.path.startsWith(folder))
    );
    const config = vscode.workspace.getConfiguration("branchDiffLocal", vscode.Uri.file(this.repoRoot));
    const tree = buildFileTree(visible, config.get<boolean>("groupByFolder", true));
    this.roots = tree.roots;
    this.totals = tree.totals;
  }

  async setTarget(target: RefSelection): Promise<void> {
    if (target.ref !== this.target?.ref) this.excludedPaths.clear();
    await this.context.workspaceState.update(this.key(TARGET_KEY), target);
    await this.refresh();
  }

  async setSource(source: RefSelection): Promise<void> {
    if (source.ref !== this.source.ref) this.excludedPaths.clear();
    await this.context.workspaceState.update(this.key(SOURCE_KEY), source);
    await this.refresh();
  }

  async setComparison(source: RefSelection, target: RefSelection, useMergeBase?: boolean): Promise<void> {
    if (source.ref !== this.source.ref || target.ref !== this.target?.ref
      || (useMergeBase !== undefined && useMergeBase !== this.useMergeBase)) this.excludedPaths.clear();
    const updates = [
      this.context.workspaceState.update(this.key(SOURCE_KEY), source),
      this.context.workspaceState.update(this.key(TARGET_KEY), target),
    ];
    if (useMergeBase !== undefined) updates.push(this.context.workspaceState.update(this.key(MODE_KEY), useMergeBase));
    await Promise.all(updates);
    await this.refresh();
  }

  async setComparisonMode(useMergeBase: boolean): Promise<void> {
    if (useMergeBase !== this.useMergeBase) this.excludedPaths.clear();
    await this.context.workspaceState.update(this.key(MODE_KEY), useMergeBase);
    await this.refresh();
  }

  getChange(filePath: string): ChangePayload | undefined {
    const change = this.changes.get(filePath);
    if (this.loading || !change || !this.comparison) return undefined;
    return { repoRoot: this.repoRoot, ...this.comparison, change };
  }

  getEntry(id: string): FileTreeEntry | undefined {
    const search = (entries: FileTreeEntry[]): FileTreeEntry | undefined => {
      for (const entry of entries) {
        if (entry.id === id) return entry;
        if (entry.kind === "folder") {
          const found = search(entry.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    return search(this.roots);
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    const target = this.target;
    this.error = undefined;
    if (!target) {
      this.roots = [];
      this.totals = emptyTotals();
      this.changes.clear();
      this.comparison = undefined;
      this.onChanged();
      return;
    }

    const source = this.source;
    this.loading = true;
    this.onChanged();
    try {
      const config = vscode.workspace.getConfiguration("branchDiffLocal", vscode.Uri.file(this.repoRoot));
      const [currentBranch, result] = await Promise.all([
        getCurrentBranch(this.repoRoot).catch(() => ""),
        compareRefs(
          this.repoRoot,
          target.ref,
          source.ref,
          this.useMergeBase,
          config.get<boolean>("includeUntracked", true)
        ),
      ]);
      // A slower, superseded comparison must not replace the user's new selection.
      if (generation !== this.generation) return;
      this.currentBranch = currentBranch;
      const selectedLabel = (selection: RefSelection, sha: string) => {
        const label = refLabel(selection.ref, currentBranch, selection.branch);
        return isLiveRef(sha) || sha.startsWith(selection.ref) ? label : `${label} · ${sha.slice(0, 8)}`;
      };
      const selectedTargetLabel = selectedLabel(target, result.target);
      this.comparison = {
        target: result.target,
        base: result.base,
        source: result.source,
        mergeBase: result.mergeBase,
        selectedTargetLabel,
        targetLabel: result.mergeBase ? vscode.l10n.t("Merge base {0}", result.base.slice(0, 8)) : selectedTargetLabel,
        sourceLabel: selectedLabel(source, result.source),
      };
      this.changes.clear();
      for (const change of result.changes) this.changes.set(change.path, change);
      this.rebuildTree();
    } catch (error) {
      if (generation !== this.generation) return;
      this.error = error instanceof NoMergeBaseError
        ? vscode.l10n.t("These commits have no common ancestor. Use direct comparison to compare them.")
        : vscode.l10n.t(
        "Could not compare: {0}",
        error instanceof Error ? error.message : String(error)
      );
      this.roots = [];
      this.totals = emptyTotals();
      this.changes.clear();
      this.comparison = undefined;
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.onChanged();
      }
    }
  }
}

/** Repository coordination shared by the file tree and endpoint commands. */
export class ChangedFilesProvider implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly sessions = new Map<string, RepoSession>();

  constructor(private readonly context: vscode.ExtensionContext) {}

  /** Keep comparisons saved by versions before per-repository state. */
  async migrateLegacy(repoRoot: string): Promise<void> {
    const state = this.context.workspaceState;
    const target = state.get<string>(TARGET_KEY);
    if (target === undefined) return;
    const perRepoTarget = `${TARGET_KEY}:${repoRoot}`;
    if (state.get<string>(perRepoTarget) === undefined) {
      await state.update(perRepoTarget, target);
      const source = state.get<string>(SOURCE_KEY);
      if (source !== undefined) await state.update(`${SOURCE_KEY}:${repoRoot}`, source);
    }
    await state.update(TARGET_KEY, undefined);
    await state.update(SOURCE_KEY, undefined);
  }

  async setRepos(roots: string[]): Promise<void> {
    for (const root of this.sessions.keys()) {
      if (!roots.includes(root)) this.sessions.delete(root);
    }
    for (const root of roots) {
      if (!this.sessions.has(root)) {
        this.sessions.set(root, new RepoSession(root, this.context, () => this.changed.fire()));
      }
    }
    await this.refreshAll();
  }

  sessionList(): RepoSession[] {
    return [...this.sessions.values()].sort((a, b) => a.repoRoot.localeCompare(b.repoRoot));
  }

  getSession(root: string): RepoSession | undefined {
    return this.sessions.get(root);
  }

  get totalFileCount(): number {
    return this.sessionList().reduce((total, session) => total + session.totals.files, 0);
  }

  async refreshAll(): Promise<void> {
    await Promise.all(this.sessionList().map((session) => session.refresh()));
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
    this.sessions.clear();
  }
}

export interface EntryContext {
  session: RepoSession;
  entry: FileTreeEntry;
}

export function entryUri(context: EntryContext): vscode.Uri {
  return vscode.Uri.file(path.join(context.session.repoRoot, context.entry.path));
}
