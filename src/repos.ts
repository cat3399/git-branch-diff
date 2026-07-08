import * as vscode from "vscode";
import { getRepoRoot } from "./git";

/** Minimal shape of the built-in Git extension API we rely on. */
interface GitApiLike {
  repositories: { rootUri: vscode.Uri }[];
  onDidOpenRepository?: vscode.Event<unknown>;
  onDidCloseRepository?: vscode.Event<unknown>;
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
  let timer: ReturnType<typeof setTimeout> | undefined;

  const fire = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(callback, 300);
  };

  disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(fire));

  // Subscribe to Git-extension repo events when the API is available.
  void getGitApi().then((api) => {
    api?.onDidOpenRepository?.(fire, undefined, disposables);
    api?.onDidCloseRepository?.(fire, undefined, disposables);
  });

  return new vscode.Disposable(() => {
    if (timer) {
      clearTimeout(timer);
    }
    for (const d of disposables) {
      d.dispose();
    }
  });
}
