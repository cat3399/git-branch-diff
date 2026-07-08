import * as vscode from "vscode";
import { showFileAtRef } from "./git";

export const BRANCH_DIFF_SCHEME = "branchdiff";

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
  implements vscode.TextDocumentContentProvider
{
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
    return showFileAtRef(params.repoRoot, params.ref, params.path);
  }
}
