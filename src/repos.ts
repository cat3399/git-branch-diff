import * as vscode from "vscode";
import { getRepoRoot } from "./git";

/** Minimal shape of the built-in Git extension API we rely on. */
interface GitRepositoryLike {
  rootUri: vscode.Uri;
  state: { onDidChange: vscode.Event<void> };
}

interface GitApiLike {
  repositories: GitRepositoryLike[];
  onDidOpenRepository?: vscode.Event<GitRepositoryLike>;
  onDidCloseRepository?: vscode.Event<GitRepositoryLike>;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

/** Get the built-in Git extension's API, activating the extension if needed. */
async function getGitApi(): Promise<GitApiLike | undefined> {
  const ext = vscode.extensions.getExtension<{
    getAPI(version: 1): GitApiLike;
  }>("vscode.git");
  if (!ext) {
    return undefined;
  }
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}

/**
 * Discover git repositories in the workspace. Prefers the built-in Git
 * extension's repository list (same repos as Source Control, including nested
 * ones); falls back to scanning workspace folders when it is unavailable.
 */
export async function discoverRepos(): Promise<string[]> {
  const api = await getGitApi();
  if (api && api.repositories.length > 0) {
    return unique(api.repositories.map((r) => r.rootUri.fsPath));
  }

  const roots: string[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = await getRepoRoot(folder.uri.fsPath);
    if (root) {
      roots.push(root);
    }
  }
  return unique(roots);
}

/**
 * Fire `callback` (debounced) whenever the set of repositories may have
 * changed — repos opened/closed in Source Control, or workspace folders added
 * or removed.
 */
export function onDidChangeRepos(callback: () => void): vscode.Disposable {
  const disposables: vscode.Disposable[] = [];
  const repoListeners = new Map<string, vscode.Disposable>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const fire = () => {
    if (disposed) return;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(callback, 300);
  };

  disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(fire));

  // Subscribe to Git-extension repo events when the API is available.
  void getGitApi().then((api) => {
    if (!api || disposed) return;
    const watch = (repo: GitRepositoryLike) => {
      const root = repo.rootUri.toString();
      repoListeners.get(root)?.dispose();
      repoListeners.set(root, repo.state.onDidChange(fire));
    };
    for (const repo of api.repositories) watch(repo);
    api.onDidOpenRepository?.((repo) => {
      watch(repo);
      fire();
    }, undefined, disposables);
    api.onDidCloseRepository?.((repo) => {
      const root = repo.rootUri.toString();
      repoListeners.get(root)?.dispose();
      repoListeners.delete(root);
      fire();
    }, undefined, disposables);
  });

  return new vscode.Disposable(() => {
    disposed = true;
    if (timer) {
      clearTimeout(timer);
    }
    for (const d of disposables) {
      d.dispose();
    }
    for (const listener of repoListeners.values()) listener.dispose();
  });
}
