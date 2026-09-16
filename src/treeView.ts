import * as vscode from "vscode";
import * as path from "path";
import { randomBytes } from "crypto";
import { ChangedFilesProvider } from "./treeProvider";
import { FileIcons } from "./fileIcons";
import { FileTreeEntry } from "./fileTree";

const actions = new Set(["openChange", "openFile"]);

/** A small webview lets status badges have color without coloring the file label. */
export class ChangedFilesView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private icons: FileIcons | undefined;
  private iconGeneration = 0;
  private readonly iconsReady: Promise<void>;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly provider: ChangedFilesProvider
  ) {
    this.disposables.push(
      provider.onDidChangeTreeData(() => this.update()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("workbench.iconTheme")) void this.loadIcons();
      }),
      vscode.window.onDidChangeActiveColorTheme(() => void this.loadIcons()),
      vscode.extensions.onDidChange(() => void this.loadIcons())
    );
    this.iconsReady = this.loadIcons();
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    await this.iconsReady;
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: this.resourceRoots(),
    };
    const nonce = randomBytes(16).toString("hex");
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "tree.css"));
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "tree.js"));
    const codicons = view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "icons", "codicon.css"));
    view.webview.html = `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; img-src ${view.webview.cspSource} data:; font-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${codicons}">
  <link rel="stylesheet" href="${css}">
</head>
<body>
  <main id="repositories"></main>
  <script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
    const viewDisposables = [
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (!message || typeof message !== "object") return;
        const request = message as Record<string, unknown>;
        if (request.action === "ready") {
          this.update();
          return;
        }
        if (typeof request.action !== "string" || !actions.has(request.action)) return;
        if (typeof request.repoRoot !== "string") return;
        const session = this.provider.getSession(request.repoRoot);
        if (!session) return;
        if (request.action === "openChange" || request.action === "openFile") {
          if (typeof request.entryId !== "string") return;
          const entry = session.getEntry(request.entryId);
          if (entry?.kind !== "file") return;
        }
        void vscode.commands.executeCommand("branchDiffLocal." + request.action, {
          repoRoot: request.repoRoot, entryId: request.entryId,
        });
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible) this.update();
      }),
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
        for (const disposable of viewDisposables) disposable.dispose();
      })
    ];
    this.update();
  }

  private resourceRoots(): vscode.Uri[] {
    return [
      vscode.Uri.joinPath(this.extensionUri, "media"),
      vscode.Uri.joinPath(this.extensionUri, "dist"),
      ...(this.icons ? [this.icons.resourceRoot] : []),
    ];
  }

  private async loadIcons(): Promise<void> {
    const generation = ++this.iconGeneration;
    try {
      const icons = await FileIcons.load();
      if (generation !== this.iconGeneration) return;
      this.icons = icons;
    } catch (error) {
      if (generation !== this.iconGeneration) return;
      this.icons = undefined;
      console.warn("Branch Diff: could not load the file icon theme", error);
    }
    if (this.view) this.view.webview.options = { enableScripts: true, localResourceRoots: this.resourceRoots() };
    this.update();
  }

  private update(): void {
    if (!this.view) return;
    const webview = this.view.webview;
    const withIcons = (entries: FileTreeEntry[]): object[] => entries.map((entry) => ({
      ...entry,
      icon: this.icons?.icon(webview, entry),
      ...(entry.kind === "folder" ? {
        expandedIcon: this.icons?.icon(webview, entry, true),
        children: withIcons(entry.children),
      } : {}),
    }));
    const sessions = this.provider.sessionList();
    this.view.title = sessions.length === 1 && sessions[0].target
      ? `${sessions[0].targetLabel} ↔ ${sessions[0].sourceLabel}`
      : vscode.l10n.t("Changed files");
    this.view.badge = this.provider.totalFileCount
      ? { value: this.provider.totalFileCount, tooltip: vscode.l10n.t("Changed files") }
      : undefined;
    void this.view.webview.postMessage({
      type: "tree",
      fonts: this.icons?.fonts(webview) ?? [],
      repositories: sessions.map((session) => ({
        root: session.repoRoot,
        name: path.basename(session.repoRoot),
        base: session.targetLabel,
        source: session.sourceLabel,
        selected: Boolean(session.target),
        loading: session.loading,
        error: session.error,
        comparison: session.comparisonLabel,
        comparisonDetails: session.comparisonDetails,
        summary: session.summary,
        totals: session.totals,
        roots: withIcons(session.roots),
      })),
      labels: {
        openFile: vscode.l10n.t("Open working file"),
        select: vscode.l10n.t("Select a base to start comparing"),
        noRepos: vscode.l10n.t("Open a Git repository to compare files"),
        noChanges: vscode.l10n.t("No changes"),
        loading: vscode.l10n.t("Comparing…"),
        binary: vscode.l10n.t("binary"),
        changedFiles: vscode.l10n.t("Changed files"),
      },
      locale: vscode.env.language,
    });
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}
