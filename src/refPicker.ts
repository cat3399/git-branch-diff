import * as vscode from "vscode";
import {
  getCurrentBranch, getMainlineBranch, getMergeBase, GitBranch, GitCommit, HEAD_REF,
  INDEX_REF, isLiveRef, listBranches, listCommits, listTags, NoMergeBaseError,
  resolveCommit, verifyRef, WORKTREE_REF,
} from "./git";

export interface RefSelection {
  ref: string;
  /** The branch whose history was used to select this fixed commit. */
  branch?: string;
}

export type RefPickResult = RefSelection | {
  kind: "pr";
  source: RefSelection;
  target: RefSelection;
};

type RefItem = vscode.QuickPickItem & {
  ref?: string;
  branch?: GitBranch;
  action?: "manual" | "branch" | "commits" | "more" | "pr" | "pr-target";
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

/** Both sides can turn the opposite selection into the source of a PR comparison. */
export async function pickRef(
  repoRoot: string,
  title: string,
  selected?: string,
  opposite?: RefSelection
): Promise<RefPickResult | undefined> {
  const [branches, tags, current] = await Promise.all([
    listBranches(repoRoot), listTags(repoRoot), getCurrentBranch(repoRoot).catch(() => ""),
  ]);
  const separator = (label: string): RefItem => ({
    label, kind: vscode.QuickPickItemKind.Separator,
  });
  const prSource = opposite?.ref === HEAD_REF && current && current !== HEAD_REF
    ? { ref: "refs/heads/" + current } : opposite;
  const prItems = prSource ? await buildPrItems(repoRoot, prSource, branches) : [];
  const items: RefItem[] = [
    ...(prItems.length && prSource ? [
      separator(vscode.l10n.t("PR comparison · {0}", refLabel(prSource.ref, current, prSource.branch))),
      ...prItems,
      separator(vscode.l10n.t("Other versions")),
    ] : []),
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
    if (!remote) {
      group.sort((left, right) => Number(right.name === current) - Number(left.name === current));
    }
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
      matchOnDetail: true,
    });
    if (!picked) return undefined;
    if (picked.action === "pr" && picked.branch && prSource) {
      return { kind: "pr", source: prSource, target: { ref: picked.branch.ref } };
    }
    if (picked.action === "pr-target" && prSource) {
      const target = await vscode.window.showQuickPick(branches.map((branch) => ({
        label: branch.name,
        description: branch.remote ? vscode.l10n.t("Remote branches") : vscode.l10n.t("Local branches"),
        branch,
      })), {
        title: vscode.l10n.t("Choose a PR target branch…"),
        placeHolder: vscode.l10n.t("Select the branch you would merge into"),
        matchOnDescription: true,
      });
      if (!target) continue;
      return { kind: "pr", source: prSource, target: { ref: target.branch.ref } };
    }
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

async function buildPrItems(repoRoot: string, source: RefSelection, branches: GitBranch[]): Promise<RefItem[]> {
  if (isLiveRef(source.ref) || !branches.length || !await verifyRef(repoRoot, source.ref)) return [];
  const mainline = await getMainlineBranch(repoRoot, branches);
  const sourceBranch = branches.find((branch) =>
    branch.ref === (source.branch ?? source.ref) || branch.name === (source.branch ?? source.ref));
  const mainlineName = mainline?.remote ? mainline.name.replace(/^[^/]+\//, "") : mainline?.name;
  if (mainline && sourceBranch && (sourceBranch.ref === mainline.ref
    || (!sourceBranch.remote && sourceBranch.name === mainlineName))) return [];

  const items: RefItem[] = [];
  let targetDetail = vscode.l10n.t("View changes from the common ancestor with another target branch");
  if (mainline) {
    try {
      const sourceCommit = await resolveCommit(repoRoot, source.ref);
      const mergeBase = await getMergeBase(repoRoot, sourceCommit, mainline.ref);
      const [commit] = await listCommits(repoRoot, 0, 1, mergeBase);
      items.push({
        label: "$(git-pull-request) " + vscode.l10n.t("Compare with mainline (PR)"),
        description: mainline.name,
        detail: vscode.l10n.t("Merge base: {0} · {1}", mergeBase.slice(0, 9), commit.subject),
        branch: mainline,
        action: "pr",
      });
    } catch (error) {
      if (!(error instanceof NoMergeBaseError)) throw error;
      targetDetail = vscode.l10n.t("No common ancestor with {0}; choose another target branch", mainline.name);
    }
  }
  items.push({
    label: "$(git-branch) " + vscode.l10n.t("Choose a PR target branch…"),
    detail: targetDetail,
    action: "pr-target",
  });
  return items;
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
