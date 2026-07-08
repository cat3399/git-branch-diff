import * as vscode from "vscode";
import * as path from "path";
import {
  BRANCH_DIFF_SCHEME,
  BranchDiffContentProvider,
  makeDiffUri,
} from "./contentProvider";
import { listBranches, listTags, verifyRef } from "./git";
import { discoverRepos, onDidChangeRepos } from "./repos";
import {
  BranchDiffNode,
  ChangeItem,
  ChangePayload,
  ChangedFilesProvider,
  FolderItem,
  HEAD_SOURCE,
  RepoItem,
  RepoSession,
  WORKTREE_SOURCE,
  StatusDecorationProvider,
} from "./treeProvider";

export async function activate(context: vscode.ExtensionContext) {
  // Content provider that resolves file contents at a git ref via `git show`.
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      BRANCH_DIFF_SCHEME,
      new BranchDiffContentProvider()
    )
  );

  // Colored status-letter badges (M / A / D / R …) on each file item.
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(new StatusDecorationProvider())
  );

  const treeProvider = new ChangedFilesProvider(context);
  const view = vscode.window.createTreeView("branchDiff.filesView", {
    treeDataProvider: treeProvider,
  });
  context.subscriptions.push(view);

  const updateTitle = () => {
    const sessions = treeProvider.sessionList();
    if (sessions.length === 1) {
      const s = sessions[0];
      view.description = s.target ? `${s.sourceLabel} → ${s.target}` : undefined;
    } else {
      view.description = sessions.length
        ? `${sessions.length} repositories`
        : undefined;
    }
  };

  // Reflect the total changed-file count as a view badge and the +/- summary as
  // the view message, updated on every refresh.
  context.subscriptions.push(
    treeProvider.onDidChangeTreeData(() => {
      const count = treeProvider.totalFileCount;
      const summary = treeProvider.summary;
      view.badge = count ? { value: count, tooltip: summary } : undefined;
      view.message = summary || undefined;
      updateTitle();
    })
  );

  // Discover repositories, then keep the set in sync as they open/close.
  const reload = async () => {
    const repos = await discoverRepos();
    if (repos.length === 1) {
      await treeProvider.migrateLegacy(repos[0]);
    }
    await treeProvider.setRepos(repos);
    updateTitle();
  };
  context.subscriptions.push(onDidChangeRepos(() => void reload()));

  const MANUAL = "~manual";
  type RefItem = vscode.QuickPickItem & { value?: string };

  // Shared ref picker for both source and target selection. Offers branches,
  // remotes, tags, and a free-form entry for any commit/tag/ref.
  const pickRef = async (opts: {
    repoRoot: string;
    currentBranch: string;
    placeHolder: string;
    exclude?: string;
    includeHead?: boolean;
    includeWorktree?: boolean;
  }): Promise<string | undefined> => {
    let branches: string[];
    let tags: string[];
    try {
      [branches, tags] = await Promise.all([
        listBranches(opts.repoRoot),
        listTags(opts.repoRoot).catch(() => [] as string[]),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Branch Diff: ${msg}`);
      return undefined;
    }

    const sep = (label: string): RefItem => ({
      label,
      kind: vscode.QuickPickItemKind.Separator,
    });
    const refItem = (value: string): RefItem => ({
      label: value,
      description: value === opts.currentBranch ? "current" : undefined,
      value,
    });

    const items: RefItem[] = [];
    if (opts.includeWorktree) {
      items.push({
        label: "$(edit) Working Tree",
        description: "uncommitted changes",
        value: WORKTREE_SOURCE,
      });
    }
    if (opts.includeHead) {
      items.push({
        label: "$(git-branch) Current branch",
        description: opts.currentBranch || "HEAD",
        value: HEAD_SOURCE,
      });
    }
    items.push({
      label: "$(edit) Enter a ref…",
      description: "commit, tag, or any git ref",
      value: MANUAL,
    });

    const keep = (r: string) => r !== opts.exclude;
    const locals = branches.filter((b) => !b.includes("/") && keep(b));
    const remotes = branches.filter((b) => b.includes("/") && keep(b));
    const tagList = tags.filter(keep);
    if (locals.length) {
      items.push(sep("Branches"), ...locals.map(refItem));
    }
    if (remotes.length) {
      items.push(sep("Remotes"), ...remotes.map(refItem));
    }
    if (tagList.length) {
      items.push(sep("Tags"), ...tagList.map(refItem));
    }

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: opts.placeHolder,
    });
    if (!picked?.value) {
      return undefined;
    }
    if (picked.value !== MANUAL) {
      return picked.value;
    }

    // Free-form ref entry with validation.
    const entered = await vscode.window.showInputBox({
      placeHolder: "e.g. a1b2c3d, v1.2.0, origin/main, HEAD~3",
      prompt: "Enter a commit hash, tag, or git ref",
      validateInput: async (v) => {
        const ref = v.trim();
        if (!ref) {
          return "Enter a ref";
        }
        return (await verifyRef(opts.repoRoot, ref))
          ? null
          : "Not a valid git ref";
      },
    });
    return entered?.trim() || undefined;
  };

  // Resolve which repo a command targets: the clicked repo header, the sole
  // repo, or a prompt when the workspace has several.
  const resolveRepo = async (
    arg?: unknown
  ): Promise<RepoSession | undefined> => {
    if (arg instanceof RepoItem) {
      return arg.session;
    }
    const sessions = treeProvider.sessionList();
    if (sessions.length === 0) {
      vscode.window.showInformationMessage(
        "Branch Diff: no git repository found in this workspace."
      );
      return undefined;
    }
    if (sessions.length === 1) {
      return sessions[0];
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map((s) => ({
        label: path.basename(s.repoRoot),
        description: s.repoRoot,
        session: s,
      })),
      { placeHolder: "Select a repository" }
    );
    return picked?.session;
  };

  // Resolve a session's source to a concrete branch name (for exclusion/swap).
  const resolvedSourceOf = (s: RepoSession) => {
    const src = s.source;
    // The working tree and HEAD both sit on the current branch.
    return src === HEAD_SOURCE || src === WORKTREE_SOURCE ? s.currentBranch : src;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "branchDiff.selectTarget",
      async (arg?: unknown) => {
        const session = await resolveRepo(arg);
        if (!session) {
          return;
        }
        const picked = await pickRef({
          repoRoot: session.repoRoot,
          currentBranch: session.currentBranch,
          placeHolder: `Compare "${session.sourceLabel}" against…`,
          exclude: resolvedSourceOf(session),
        });
        if (picked) {
          await session.setTarget(picked);
        }
      }
    ),
    vscode.commands.registerCommand(
      "branchDiff.selectSource",
      async (arg?: unknown) => {
        const session = await resolveRepo(arg);
        if (!session) {
          return;
        }
        const picked = await pickRef({
          repoRoot: session.repoRoot,
          currentBranch: session.currentBranch,
          placeHolder: "Select the source to compare from",
          exclude: session.target,
          includeHead: true,
          includeWorktree: true,
        });
        if (picked) {
          await session.setSource(picked);
        }
      }
    ),
    vscode.commands.registerCommand("branchDiff.swap", async (arg?: unknown) => {
      const session = await resolveRepo(arg);
      if (!session) {
        return;
      }
      const target = session.target;
      if (!target) {
        vscode.window.showInformationMessage(
          "Branch Diff: select a target branch first."
        );
        return;
      }
      if (session.source === WORKTREE_SOURCE) {
        vscode.window.showInformationMessage(
          "Branch Diff: the Working Tree can't be used as a target."
        );
        return;
      }
      const newTarget = resolvedSourceOf(session);
      if (!newTarget) {
        vscode.window.showInformationMessage(
          "Branch Diff: can't determine the current branch to swap."
        );
        return;
      }
      await session.setComparison(target, newTarget);
    }),
    vscode.commands.registerCommand(
      "branchDiff.refresh",
      async (arg?: unknown) => {
        if (arg instanceof RepoItem) {
          await arg.session.refresh();
        } else {
          await treeProvider.refreshAll();
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "branchDiff.openChange",
      async (payload: ChangePayload) => {
        await openChange(payload);
      }
    )
  );

  // Open the real, editable file on disk (from the row's hover icon / context
  // menu), so a diff of committed refs can still be edited.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "branchDiff.openFile",
      async (item: ChangeItem) => {
        await openFile(item);
      }
    ),
    vscode.commands.registerCommand(
      "branchDiff.openToSide",
      async (item: ChangeItem) => {
        await openToSide(item);
      }
    ),
    vscode.commands.registerCommand(
      "branchDiff.copyPath",
      async (item: BranchDiffNode) => {
        await copyPath(item);
      }
    ),
    vscode.commands.registerCommand(
      "branchDiff.copyRelativePath",
      async (item: BranchDiffNode) => {
        await copyRelativePath(item);
      }
    ),
    vscode.commands.registerCommand(
      "branchDiff.revealInExplorer",
      async (item: BranchDiffNode) => {
        await revealInExplorer(item);
      }
    )
  );

  // Line-level actions available when right-clicking inside a diff pane.
  context.subscriptions.push(
    vscode.commands.registerCommand("branchDiff.openFileAtLine", async () => {
      await openFileAtLine();
    }),
    vscode.commands.registerCommand("branchDiff.copyLineReference", async () => {
      await copyLineReference();
    }),
    vscode.commands.registerCommand("branchDiff.copyLine", async () => {
      await copyLine();
    })
  );

  // Re-render every repo when a Branch Diff setting (grouping, merge-base…) changes.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("branchDiff")) {
        void treeProvider.refreshAll();
      }
    })
  );

  // Initial discovery + populate.
  await reload();
}

async function openChange(payload: ChangePayload): Promise<void> {
  const { repoRoot, base, source, sourceLabel, targetLabel, change } = payload;
  const leftPath = change.oldPath ?? change.path;

  // Left ("before"): the file at the diff base. For added files this resolves
  // to empty content because the path does not exist at `base`.
  const left = makeDiffUri({ repoRoot, ref: base, path: leftPath });

  // Right ("after"): for the working-tree source, use the live file on disk so
  // it reflects uncommitted edits and stays editable; deletions have no file,
  // so show empty content. Otherwise use the file at the source ref.
  let right: vscode.Uri;
  if (source === WORKTREE_SOURCE) {
    right =
      change.status === "D"
        ? makeDiffUri({ repoRoot, ref: "", path: change.path })
        : vscode.Uri.file(path.join(repoRoot, change.path));
  } else {
    right = makeDiffUri({ repoRoot, ref: source, path: change.path });
  }

  const sides = `${targetLabel} ↔ ${sourceLabel}`;
  const title =
    change.status === "R" && change.oldPath
      ? `${change.oldPath} → ${change.path} (${sides})`
      : `${path.basename(change.path)} (${sides})`;

  await vscode.commands.executeCommand("vscode.diff", left, right, title, {
    preview: true,
  });
}

/** Real (file:) URI for a tree node — from the folder's URI or the change path. */
function fileUriOf(item: BranchDiffNode): vscode.Uri {
  if (item instanceof FolderItem) {
    return item.resourceUri!;
  }
  return vscode.Uri.file(
    path.join(item.payload.repoRoot, item.payload.change.path)
  );
}

/** Repo-relative path for a tree node. */
function relPathOf(item: BranchDiffNode): string {
  return item instanceof FolderItem ? item.relPath : item.payload.change.path;
}

/** Warn (and return false) when the path is not present in the working tree. */
async function ensureExists(uri: vscode.Uri, relPath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    vscode.window.showWarningMessage(
      `Branch Diff: "${relPath}" is not present in the working tree ` +
        `(it may be deleted, or only exist on another branch).`
    );
    return false;
  }
}

/** Open the working-tree file for a change so it can be edited directly. */
async function openFile(item: ChangeItem): Promise<void> {
  const fileUri = fileUriOf(item);
  if (await ensureExists(fileUri, relPathOf(item))) {
    await vscode.window.showTextDocument(fileUri, { preview: false });
  }
}

/** Copy the absolute path of a tree node to the clipboard. */
async function copyPath(item: BranchDiffNode): Promise<void> {
  await vscode.env.clipboard.writeText(fileUriOf(item).fsPath);
}

/** Copy the repo-relative path of a tree node to the clipboard. */
async function copyRelativePath(item: BranchDiffNode): Promise<void> {
  await vscode.env.clipboard.writeText(relPathOf(item));
}

/** Reveal a tree node in the Explorer side bar. */
async function revealInExplorer(item: BranchDiffNode): Promise<void> {
  const fileUri = fileUriOf(item);
  if (await ensureExists(fileUri, relPathOf(item))) {
    await vscode.commands.executeCommand("revealInExplorer", fileUri);
  }
}

/** Open the working-tree file in a split editor beside the current one. */
async function openToSide(item: ChangeItem): Promise<void> {
  const fileUri = fileUriOf(item);
  if (await ensureExists(fileUri, relPathOf(item))) {
    await vscode.commands.executeCommand("vscode.open", fileUri, {
      viewColumn: vscode.ViewColumn.Beside,
    });
  }
}

interface DiffLineContext {
  editor: vscode.TextEditor;
  repoRoot: string;
  /** Repo-relative path of the file shown in this diff pane. */
  path: string;
  selection: vscode.Selection;
}

/**
 * Resolve the active editor as a Branch Diff pane and its cursor/selection. The
 * diff panes use the `branchdiff:` scheme and carry {repoRoot, path} in their
 * URI. Returns undefined when the active editor isn't one of our diff panes.
 */
function diffLineContext(): DiffLineContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== BRANCH_DIFF_SCHEME) {
    return undefined;
  }
  let params: { repoRoot?: string; path?: string };
  try {
    params = JSON.parse(editor.document.uri.query);
  } catch {
    return undefined;
  }
  if (!params.repoRoot || !params.path) {
    return undefined;
  }
  return {
    editor,
    repoRoot: params.repoRoot,
    path: params.path,
    selection: editor.selection,
  };
}

/**
 * Open the working-tree file at the line the cursor is on in a diff pane, so it
 * can be edited (best-effort — line numbers only align exactly when the source
 * content matches the working tree).
 */
async function openFileAtLine(): Promise<void> {
  const ctx = diffLineContext();
  if (!ctx) {
    return;
  }

  const fileUri = vscode.Uri.file(path.join(ctx.repoRoot, ctx.path));
  if (!(await ensureExists(fileUri, ctx.path))) {
    return;
  }

  const opened = await vscode.window.showTextDocument(fileUri, {
    preview: false,
  });
  const target = Math.min(
    ctx.selection.active.line,
    opened.document.lineCount - 1
  );
  const pos = new vscode.Position(target, 0);
  opened.selection = new vscode.Selection(pos, pos);
  opened.revealRange(
    new vscode.Range(pos, pos),
    vscode.TextEditorRevealType.InCenter
  );
}

/** Copy a `path:line` (or `path:start-end`) reference for the diff selection. */
async function copyLineReference(): Promise<void> {
  const ctx = diffLineContext();
  if (!ctx) {
    return;
  }
  const start = ctx.selection.start.line + 1;
  const end = ctx.selection.end.line + 1;
  const ref = start === end ? `${ctx.path}:${start}` : `${ctx.path}:${start}-${end}`;
  await vscode.env.clipboard.writeText(ref);
}

/** Copy the full text of the line(s) the diff selection touches. */
async function copyLine(): Promise<void> {
  const ctx = diffLineContext();
  if (!ctx) {
    return;
  }
  const doc = ctx.editor.document;
  const from = doc.lineAt(ctx.selection.start.line).range.start;
  const to = doc.lineAt(ctx.selection.end.line).range.end;
  await vscode.env.clipboard.writeText(doc.getText(new vscode.Range(from, to)));
}

export function deactivate() {}
