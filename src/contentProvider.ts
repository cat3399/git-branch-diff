import * as vscode from "vscode";
import { INDEX_REF, showFileAtRef } from "./git";

export const BRANCH_DIFF_SCHEME = "branchdiff-local";

interface DiffUriParams {
  repoRoot: string;
  ref: string;
  path: string;
}

/**
 * Build a `branchdiff:` URI that resolves to the contents of `path` at `ref`.
 * The file basename is kept as the URI path so VS Code applies language/icon
 * detection; the real params live in the query string.
 */
export function makeDiffUri(params: DiffUriParams): vscode.Uri {
  const query = JSON.stringify(params);
  return vscode.Uri.from({
    scheme: BRANCH_DIFF_SCHEME,
    // Preserve the file path so the editor keeps the right language mode.
    path: "/" + params.path,
    query,
  });
}

export class BranchDiffContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly indexDocuments = new Map<string, vscode.Uri>();
  private readonly closed = vscode.workspace.onDidCloseTextDocument((document) => {
    this.indexDocuments.delete(document.uri.toString());
  });

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    let params: DiffUriParams;
    try {
      params = JSON.parse(uri.query) as DiffUriParams;
    } catch {
      return "";
    }
    if (!params.ref || !params.path || !params.repoRoot) {
      return "";
    }
    if (params.ref === INDEX_REF) this.indexDocuments.set(uri.toString(), uri);
    return showFileAtRef(params.repoRoot, params.ref, params.path);
  }

  refresh(): void {
    for (const uri of this.indexDocuments.values()) this.changed.fire(uri);
  }

  dispose(): void {
    this.closed.dispose();
    this.changed.dispose();
    this.indexDocuments.clear();
  }
}
