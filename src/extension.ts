import * as vscode from "vscode";
import * as path from "path";
import { BRANCH_DIFF_SCHEME, BranchDiffContentProvider, makeDiffUri } from "./contentProvider";
import { HEAD_REF, INDEX_REF, WORKTREE_REF } from "./git";
import { discoverRepos, onDidChangeRepos } from "./repos";
import { pickRef } from "./refPicker";
import { ChangedFilesProvider, ChangePayload, EntryContext, entryUri, RepoSession } from "./treeProvider";
import { ChangedFilesView } from "./treeView";
import { FileTreeEntry } from "./fileTree";

export async function activate(context: vscode.ExtensionContext) {
  const contentProvider = new BranchDiffContentProvider();
  const treeProvider = new ChangedFilesProvider(context);
  const treeView = new ChangedFilesView(context.extensionUri, treeProvider);
  const updateDiffContext = () => {
    void vscode.commands.executeCommand("setContext", "branchDiffLocal.diffActive", Boolean(getActiveBranchDiff()));
  };
  context.subscriptions.push(
    contentProvider,
    treeProvider,
    treeView,
    vscode.workspace.registerTextDocumentContentProvider(BRANCH_DIFF_SCHEME, contentProvider),
    vscode.window.registerWebviewViewProvider("branchDiffLocal.filesView", treeView),
    vscode.window.tabGroups.onDidChangeTabs(updateDiffContext),
    vscode.window.tabGroups.onDidChangeTabGroups(updateDiffContext),
    treeProvider.onDidChangeTreeData(() => {
      contentProvider.refresh();
      void vscode.commands.executeCommand("setContext", "branchDiffLocal.hasExclusions",
        treeProvider.sessionList().some((session) => session.hasExclusions));
    })
  );
  updateDiffContext();

  const reload = async () => {
    const repos = await discoverRepos();
    if (repos.length === 1) await treeProvider.migrateLegacy(repos[0]);
    await treeProvider.setRepos(repos);
  };
  context.subscriptions.push(onDidChangeRepos(() => void reload()));

  const resolveRepo = async (arg?: unknown): Promise<RepoSession | undefined> => {
    if (arg && typeof arg === "object") {
      const data = arg as Record<string, unknown>;
      const root = data.repoRoot ?? data.branchDiffLocalRepo;
      if (typeof root === "string") return treeProvider.getSession(root);
    }
    const sessions = treeProvider.sessionList();
    if (!sessions.length) {
      void vscode.window.showInformationMessage(vscode.l10n.t("No Git repository found in this workspace"));
      return undefined;
    }
    if (sessions.length === 1) return sessions[0];
    const picked = await vscode.window.showQuickPick(sessions.map((session) => ({
      label: path.basename(session.repoRoot),
      description: session.repoRoot,
      session,
    })), { placeHolder: vscode.l10n.t("Select a repository") });
    return picked?.session;
  };

  const resolveEntry = async (arg?: unknown): Promise<EntryContext | undefined> => {
    if (!arg || typeof arg !== "object") return undefined;
    const data = arg as Record<string, unknown>;
    const entryId = data.entryId ?? data.branchDiffLocalEntry;
    if (typeof entryId !== "string") return undefined;
    const session = await resolveRepo(arg);
    const entry = session?.getEntry(entryId);
    return session && entry ? { session, entry } : undefined;
  };

  const register = (name: string, handler: (arg?: unknown) => Promise<void>) => {
    context.subscriptions.push(vscode.commands.registerCommand("branchDiffLocal." + name, async (arg?: unknown) => {
      try {
        await handler(arg);
      } catch (error) {
        void vscode.window.showErrorMessage(vscode.l10n.t(
          "Branch Diff: {0}", error instanceof Error ? error.message : String(error)
        ));
      }
    }));
  };

  register("selectTarget", async (arg) => {
    const session = await resolveRepo(arg);
    if (!session) return;
    const selected = await pickRef(session.repoRoot, vscode.l10n.t("Select base (left)"), session.target?.ref, session.source);
    if (!selected) return;
    if ("kind" in selected) await session.setComparison(selected.source, selected.target, true);
    else await session.setTarget(selected);
  });
  register("selectSource", async (arg) => {
    const session = await resolveRepo(arg);
    if (!session) return;
    const selected = await pickRef(session.repoRoot, vscode.l10n.t("Select comparison (right)"), session.source.ref, session.target);
    if (!selected) return;
    if ("kind" in selected) await session.setComparison(selected.source, selected.target, true);
    else await session.setSource(selected);
  });
  register("swap", async (arg) => {
    const session = await resolveRepo(arg);
    if (!session) return;
    if (!session.target) {
      void vscode.window.showInformationMessage(vscode.l10n.t("Select a base first"));
      return;
    }
    await session.setComparison(session.target, session.source);
  });
  register("refresh", async (arg) => {
    if (arg) await (await resolveRepo(arg))?.refresh();
    else await treeProvider.refreshAll();
  });

  register("toggleDiffLayout", async () => {
    if (!getActiveBranchDiff()) return;
    await vscode.commands.executeCommand("toggle.diff.renderSideBySide");
  });

  register("selectComparisonMode", async (arg) => {
    const session = await resolveRepo(arg);
    if (!session) return;
    const modes = [
      {
        label: vscode.l10n.t("Compare the two selected versions"),
        detail: vscode.l10n.t("Compare the exact left and right versions, including changes on both branches"),
        useMergeBase: false,
      },
      {
        label: vscode.l10n.t("Compare from the common ancestor (PR)"),
        detail: vscode.l10n.t("Show changes introduced by the right branch; working tree and staging comparisons remain direct"),
        useMergeBase: true,
      },
    ];
    const selected = await vscode.window.showQuickPick(modes.map((mode) => ({
      ...mode,
      description: mode.useMergeBase === session.useMergeBase ? vscode.l10n.t("current") : undefined,
    })), {
      title: vscode.l10n.t("Comparison mode · {0}", path.basename(session.repoRoot)),
      placeHolder: vscode.l10n.t("This choice is saved for this repository"),
    });
    if (selected) await session.setComparisonMode(selected.useMergeBase);
  });

  const presets = [
    { command: "compareStaged", base: HEAD_REF, source: INDEX_REF },
    { command: "compareUnstaged", base: INDEX_REF, source: WORKTREE_REF },
    { command: "compareWorkingTree", base: HEAD_REF, source: WORKTREE_REF },
  ];
  for (const preset of presets) {
    register(preset.command, async (arg) => {
      const session = await resolveRepo(arg);
      if (session) await session.setComparison({ ref: preset.source }, { ref: preset.base });
    });
  }

  register("openChange", async (arg) => {
    const node = await resolveEntry(arg);
    if (node?.entry.kind !== "file") return;
    const payload = node.session.getChange(node.entry.path);
    if (payload) await openChange(payload);
  });
  register("openFile", async (arg) => {
    const node = await resolveEntry(arg);
    if (node?.entry.kind !== "file") return;
    const uri = entryUri(node);
    if (await ensureExists(uri, node.entry.path)) {
      await vscode.window.showTextDocument(uri, { preview: false });
    }
  });
  register("openToSide", async (arg) => {
    const node = await resolveEntry(arg);
    if (node?.entry.kind !== "file") return;
    const uri = entryUri(node);
    if (await ensureExists(uri, node.entry.path)) {
      await vscode.commands.executeCommand("vscode.open", uri, { viewColumn: vscode.ViewColumn.Beside });
    }
  });
  register("copyPath", async (arg) => {
    const node = await resolveEntry(arg);
    if (node) await vscode.env.clipboard.writeText(entryUri(node).fsPath);
  });
  register("copyRelativePath", async (arg) => {
    const node = await resolveEntry(arg);
    if (node) await vscode.env.clipboard.writeText(node.entry.path);
  });
  register("excludeEntry", async (arg) => {
    const node = await resolveEntry(arg);
    if (!node) return;
    const selection = arg && typeof arg === "object" && "branchDiffLocalSelection" in arg
      ? arg.branchDiffLocalSelection : undefined;
    if (!Array.isArray(selection)) {
      node.session.excludeEntries([node.entry]);
      return;
    }
    const groups = new Map<RepoSession, FileTreeEntry[]>();
    for (const item of selection) {
      if (!item || typeof item !== "object" || typeof item.repoRoot !== "string" || typeof item.entryId !== "string") continue;
      const session = treeProvider.getSession(item.repoRoot);
      const entry = session?.getEntry(item.entryId);
      if (!session || !entry) continue;
      const entries = groups.get(session) ?? [];
      entries.push(entry);
      groups.set(session, entries);
    }
    for (const [session, entries] of groups) session.excludeEntries(entries);
  });
  register("restoreExcluded", async (arg) => {
    const session = await resolveRepo(arg);
    session?.restoreExcluded();
  });
  register("revealInExplorer", async (arg) => {
    const node = await resolveEntry(arg);
    if (!node) return;
    const uri = entryUri(node);
    if (await ensureExists(uri, node.entry.path)) {
      await vscode.commands.executeCommand("revealInExplorer", uri);
    }
  });
  register("openFileAtLine", openFileAtLine);
  register("copyLineReference", copyLineReference);
  register("copyLine", copyLine);

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void treeProvider.refreshAll(), 300);
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(scheduleRefresh),
    vscode.workspace.onDidCreateFiles(scheduleRefresh),
    vscode.workspace.onDidDeleteFiles(scheduleRefresh),
    vscode.workspace.onDidRenameFiles(scheduleRefresh),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("branchDiffLocal")) scheduleRefresh();
    }),
    new vscode.Disposable(() => {
      if (refreshTimer) clearTimeout(refreshTimer);
    })
  );
  await reload();
}

function getActiveBranchDiff(): vscode.TabInputTextDiff | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof vscode.TabInputTextDiff)) return undefined;
  return input.original.scheme === BRANCH_DIFF_SCHEME || input.modified.scheme === BRANCH_DIFF_SCHEME
    ? input : undefined;
}

async function openChange(payload: ChangePayload): Promise<void> {
  const { repoRoot, base, source, sourceLabel, targetLabel, change } = payload;
  if (change.binary) {
    void vscode.window.showInformationMessage(vscode.l10n.t(
      "Binary file changed. Use Open working file to view it."
    ));
    return;
  }
  if (change.status === "U") {
    void vscode.window.showInformationMessage(vscode.l10n.t(
      "This file has unresolved merge conflicts. Open it in Source Control to resolve them."
    ));
    return;
  }

  const uriFor = (ref: string, filePath: string, exists: boolean): vscode.Uri => {
    if (!exists) return makeDiffUri({ repoRoot, ref: "", path: filePath });
    return ref === WORKTREE_REF
      ? vscode.Uri.file(path.join(repoRoot, filePath))
      : makeDiffUri({ repoRoot, ref, path: filePath });
  };
  const left = uriFor(base, change.oldPath ?? change.path, change.status !== "A");
  const right = uriFor(source, change.path, change.status !== "D");
  const sides = `${targetLabel} ↔ ${sourceLabel}`;
  const title = change.status === "R" && change.oldPath
    ? `${change.oldPath} → ${change.path} (${sides})`
    : `${path.basename(change.path)} (${sides})`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title, { preview: true });
}

async function ensureExists(uri: vscode.Uri, filePath: string): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    void vscode.window.showWarningMessage(vscode.l10n.t(
      '"{0}" is not in the working tree. It may be deleted or exist only on another branch.',
      filePath
    ));
    return false;
  }
}

interface DiffLineContext {
  editor: vscode.TextEditor;
  repoRoot: string;
  path: string;
  selection: vscode.Selection;
}

function diffLineContext(): DiffLineContext | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== BRANCH_DIFF_SCHEME) return undefined;
  let params: { repoRoot?: string; path?: string };
  try {
    params = JSON.parse(editor.document.uri.query);
  } catch {
    return undefined;
  }
  if (!params.repoRoot || !params.path) return undefined;
  return { editor, repoRoot: params.repoRoot, path: params.path, selection: editor.selection };
}

async function openFileAtLine(): Promise<void> {
  const ctx = diffLineContext();
  if (!ctx) return;
  const uri = vscode.Uri.file(path.join(ctx.repoRoot, ctx.path));
  if (!(await ensureExists(uri, ctx.path))) return;
  const opened = await vscode.window.showTextDocument(uri, { preview: false });
  const position = new vscode.Position(
    Math.min(ctx.selection.active.line, opened.document.lineCount - 1), 0
  );
  opened.selection = new vscode.Selection(position, position);
  opened.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
}

async function copyLineReference(): Promise<void> {
  const ctx = diffLineContext();
  if (!ctx) return;
  const start = ctx.selection.start.line + 1;
  const end = ctx.selection.end.line + 1;
  const ref = start === end ? `${ctx.path}:${start}` : `${ctx.path}:${start}-${end}`;
  await vscode.env.clipboard.writeText(ref);
}

async function copyLine(): Promise<void> {
  const ctx = diffLineContext();
  if (!ctx) return;
  const doc = ctx.editor.document;
  const from = doc.lineAt(ctx.selection.start.line).range.start;
  const to = doc.lineAt(ctx.selection.end.line).range.end;
  await vscode.env.clipboard.writeText(doc.getText(new vscode.Range(from, to)));
}

export function deactivate() {}
