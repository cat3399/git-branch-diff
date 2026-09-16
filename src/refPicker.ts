import * as vscode from "vscode";
import {
  getCurrentBranch, GitBranch, GitCommit, HEAD_REF, INDEX_REF, listBranches,
  listCommits, listTags, resolveCommit, verifyRef, WORKTREE_REF,
} from "./git";

export interface RefSelection {
  ref: string;
  /** The branch whose history was used to select this fixed commit. */
  branch?: string;
}

type RefItem = vscode.QuickPickItem & {
  ref?: string;
  branch?: GitBranch;
  action?: "manual" | "branch" | "commits" | "more";
};

export function refLabel(ref: string, currentBranch = "", branch?: string): string {
  if (ref === WORKTREE_REF) return vscode.l10n.t("Working Tree");
  if (ref === INDEX_REF) return vscode.l10n.t("Staging Area");
  if (ref === HEAD_REF) return currentBranch && currentBranch !== HEAD_REF
    ? `HEAD · ${currentBranch}` : HEAD_REF;
  if (/^[a-f0-9]{40,64}$/.test(ref)) {
    const sha = ref.slice(0, 8);
    return branch ? `${branch.replace(/^refs\/(heads|remotes)\//, "")} · ${sha}` : sha;
  }
  return ref.replace(/^refs\/(heads|remotes|tags)\//, "");
}

/** Identical choices for the left and right sides of a comparison. */
export async function pickRef(
  repoRoot: string,
  title: string,
  selected?: string
): Promise<RefSelection | undefined> {
  const [branches, tags, current] = await Promise.all([
    listBranches(repoRoot), listTags(repoRoot), getCurrentBranch(repoRoot).catch(() => ""),
  ]);
  const separator = (label: string): RefItem => ({
    label, kind: vscode.QuickPickItemKind.Separator,
  });
  const items: RefItem[] = [
    {
      label: "$(files) " + vscode.l10n.t("Working Tree"),
      description: vscode.l10n.t("Current files, including uncommitted changes"),
      ref: WORKTREE_REF,
    },
    {
      label: "$(check) " + vscode.l10n.t("Staging Area"),
      description: vscode.l10n.t("Contents staged for the next commit"),
      ref: INDEX_REF,
    },
    { label: "$(git-commit) HEAD", description: current, ref: HEAD_REF },
    {
      label: "$(history) " + vscode.l10n.t("Choose a commit…"),
      description: vscode.l10n.t("Browse commits across all local and remote branches"),
      action: "commits",
    },
    {
      label: "$(edit) " + vscode.l10n.t("Enter a ref…"),
      description: vscode.l10n.t("Commit SHA, tag, branch or HEAD~3"),
      action: "manual",
    },
  ];
  for (const remote of [false, true]) {
    const group = branches.filter((branch) => branch.remote === remote);
    if (!group.length) continue;
    items.push(separator(remote ? vscode.l10n.t("Remote branches") : vscode.l10n.t("Local branches")));
    for (const branch of group) {
      items.push({
        label: branch.name,
        description: !remote && branch.name === current ? vscode.l10n.t("current") : undefined,
        ref: branch.ref,
        branch,
        action: "branch",
      });
    }
  }
  if (tags.length) {
    items.push(separator("Tags"));
    items.push(...tags.map((tag) => ({ label: tag, ref: "refs/tags/" + tag })));
  }
  while (true) {
    const picked = await vscode.window.showQuickPick(items, {
      title,
      placeHolder: vscode.l10n.t("Select a branch for its latest commit or history, or choose another version"),
      matchOnDescription: true,
    });
    if (!picked) return undefined;
    if (picked.action === "commits" || picked.action === "branch") {
      const result = await pickCommit(repoRoot, title, picked.branch);
      if (result === "back") continue;
      return result;
    }
    if (picked.action !== "manual") return picked.ref ? { ref: picked.ref } : undefined;
    const input = await vscode.window.showInputBox({
      title,
      value: selected && ![INDEX_REF, WORKTREE_REF].includes(selected) ? selected : "",
      prompt: vscode.l10n.t("Enter a commit SHA, tag or branch"),
      placeHolder: "a1b2c3d, v1.2.0, origin/main, HEAD~3",
      validateInput: async (value) => {
        if (!value.trim()) return vscode.l10n.t("Enter a ref");
        return await verifyRef(repoRoot, value.trim())
          ? undefined : vscode.l10n.t("This ref does not resolve to a commit");
      },
    });
    return input?.trim() ? { ref: input.trim() } : undefined;
  }
}

/** Keep the picker open while paging so search and keyboard selection persist. */
async function pickCommit(
  repoRoot: string,
  title: string,
  branch?: GitBranch
): Promise<RefSelection | "back" | undefined> {
  // Pin the history root so a branch update cannot move commits between pages.
  const historyRef = branch ? await resolveCommit(repoRoot, branch.ref) : undefined;
  const pageSize = 100;
  const picker = vscode.window.createQuickPick<RefItem>();
  picker.title = `${title} · ${branch?.name ?? vscode.l10n.t("All branches")}`;
  picker.totalSteps = branch ? 3 : 2;
  picker.buttons = [vscode.QuickInputButtons.Back];
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.ignoreFocusOut = true;
  const commits: GitCommit[] = [];
  let disposed = false;
  let loading = false;
  let browsing = !branch;
  let more = false;
  const showItems = () => {
    picker.step = branch && browsing ? 3 : 2;
    picker.placeholder = browsing
      ? vscode.l10n.t("Search loaded commits by message, SHA or author")
      : vscode.l10n.t("Follow the branch or select a fixed commit");
    if (!browsing && branch) {
      picker.items = [
        {
          label: "$(git-branch) " + vscode.l10n.t("Use latest commit"),
          description: historyRef?.slice(0, 8),
          detail: vscode.l10n.t("Follow this branch as it receives new commits"),
          ref: branch.ref,
        },
        {
          label: "$(history) " + vscode.l10n.t("Choose a historical commit…"),
          detail: vscode.l10n.t("Keep the comparison fixed at the selected commit"),
          action: "commits",
        },
      ];
      return;
    }
    const items: RefItem[] = commits.map((commit) => ({
      label: commit.subject || commit.shortRef,
      description: commit.shortRef,
      detail: `${commit.author} · ${new Date(commit.date).toLocaleString(vscode.env.language)}`,
      ref: commit.ref,
    }));
    if (more) items.push({
      label: "$(chevron-down) " + vscode.l10n.t("Load more commits…"),
      alwaysShow: true,
      action: "more",
    });
    picker.items = items;
  };
  const loadMore = async () => {
    if (loading || disposed) return;
    loading = true;
    picker.busy = true;
    try {
      const page = await listCommits(repoRoot, commits.length, pageSize + 1, historyRef);
      if (disposed) return;
      more = page.length > pageSize;
      commits.push(...page.slice(0, pageSize));
      if (browsing) {
        showItems();
        if (!commits.length) picker.placeholder = vscode.l10n.t("No commits found");
      }
    } catch (error) {
      if (!disposed) {
        void vscode.window.showErrorMessage(vscode.l10n.t(
          "Could not load commits: {0}",
          error instanceof Error ? error.message : String(error)
        ));
      }
    } finally {
      loading = false;
      if (!disposed) picker.busy = false;
    }
  };
  return new Promise((resolve) => {
    let result: RefSelection | "back" | undefined;
    const disposables = [
      picker.onDidTriggerButton(() => {
        if (branch && browsing) {
          browsing = false;
          picker.value = "";
          showItems();
        } else {
          result = "back";
          picker.hide();
        }
      }),
      picker.onDidAccept(() => {
        const item = picker.selectedItems[0];
        if (!item) return;
        if (item.action === "commits") {
          browsing = true;
          picker.value = "";
          showItems();
          if (!commits.length) void loadMore();
        } else if (item.action === "more") {
          void loadMore();
        } else if (item.ref) {
          result = { ref: item.ref, ...(browsing && branch ? { branch: branch.ref } : {}) };
          picker.hide();
        }
      }),
      picker.onDidHide(() => {
        disposed = true;
        for (const disposable of disposables) disposable.dispose();
        picker.dispose();
        resolve(result);
      }),
    ];
    showItems();
    picker.show();
    if (browsing) void loadMore();
  });
}
