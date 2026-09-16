import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
  compareRefs, HEAD_REF, INDEX_REF, listBranches, listCommits, NoMergeBaseError,
  resolveCommit, showFileAtRef, verifyRef, WORKTREE_REF,
} from "./git";

const execute = promisify(execFile);

async function fixture() {
  // Fixtures stay in /tmp; no cleanup command can touch a user's repository.
  const temporary = await mkdtemp(path.join(tmpdir(), "branch-diff-test-"));
  const root = path.join(temporary, "repository");
  const hooks = path.join(temporary, "empty-hooks");
  await Promise.all([mkdir(path.join(root, "src"), { recursive: true }), mkdir(hooks)]);
  const git = async (...args: string[]) => {
    const { stdout } = await execute("git", [
      "-c", "user.name=Branch Diff Test",
      "-c", "user.email=tests@example.invalid",
      "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=" + hooks,
      ...args,
    ], { cwd: root });
    return stdout.trim();
  };
  const write = (file: string, text: string | Buffer) => writeFile(path.join(root, file), text);
  await git("init", "--initial-branch=main");
  await write("src/main.txt", "base\n");
  await write("src/old.txt", "unchanged content for rename\n");
  await write("src/deleted.txt", "delete me\n");
  await git("add", "-A");
  await git("commit", "-m", "第一个提交");
  const first = await resolveCommit(root, HEAD_REF);
  await write("src/main.txt", "base\ncommitted\n");
  await rename(path.join(root, "src/old.txt"), path.join(root, "src/renamed.txt"));
  await git("add", "-A");
  await git("commit", "-m", "第二个提交");
  const second = await resolveCommit(root, HEAD_REF);
  return { root, temporary, git, write, first, second };
}

test("cross-branch history and PR comparisons use the selected commits", async (t) => {
  const { root, temporary, git, write, first, second } = await fixture();
  await write("master-only.txt", "upstream change\n");
  await git("add", "-A");
  const masterTree = await git("write-tree");
  const master = await git("commit-tree", masterTree, "-p", second, "-m", "master advances");
  await git("update-ref", "refs/remotes/origin/master", master);

  await rename(path.join(root, "master-only.txt"), path.join(temporary, "master-only.txt"));
  await write("feature-only.txt", "feature change\n");
  await git("add", "-A");
  const featureTree = await git("write-tree");
  const feature = await git("commit-tree", featureTree, "-p", second, "-m", "feature change");
  const featureTip = await git("commit-tree", featureTree, "-p", feature, "-m", "feature advances");
  await git("update-ref", "refs/heads/feature/review", featureTip);
  const indexBefore = await readFile(path.join(root, ".git/index"));

  await t.test("each branch has its own paged history, even while HEAD is elsewhere", async () => {
    assert.deepEqual((await listCommits(root, 0, 2, "origin/master")).map((commit) => commit.ref), [master, second]);
    assert.deepEqual((await listCommits(root, 0, 2, "feature/review")).map((commit) => commit.ref), [featureTip, feature]);
    assert.deepEqual((await listCommits(root, 2, 2, featureTip)).map((commit) => commit.ref), [second, first]);
    const nextTip = await git("commit-tree", featureTree, "-p", featureTip, "-m", "new tip during paging");
    await git("update-ref", "refs/heads/feature/review", nextTip);
    assert.equal((await listCommits(root, 0, 1, featureTip))[0].ref, featureTip);
  });

  await t.test("direct mode compares the exact SHAs and PR mode starts at their ancestor", async () => {
    const direct = await compareRefs(root, master, feature);
    assert.equal(direct.target, master);
    assert.equal(direct.base, master);
    assert.equal(direct.source, feature);
    assert.equal(direct.mergeBase, undefined);
    assert.deepEqual(direct.changes.map((change) => [change.path, change.status]), [
      ["feature-only.txt", "A"], ["master-only.txt", "D"],
    ]);
    const pr = await compareRefs(root, master, feature, true);
    assert.equal(pr.target, master);
    assert.equal(pr.base, second);
    assert.equal(pr.mergeBase, second);
    assert.equal(pr.source, feature);
    assert.deepEqual(pr.changes.map((change) => change.path), ["feature-only.txt"]);
    const same = await compareRefs(root, master, master, true);
    assert.equal(same.mergeBase, master);
    assert.deepEqual(same.changes, []);
  });

  await t.test("unrelated histories report that PR mode is unavailable", async () => {
    const unrelated = await git("commit-tree", featureTree, "-m", "unrelated history");
    await assert.rejects(compareRefs(root, master, unrelated, true), NoMergeBaseError);
    assert.equal((await compareRefs(root, master, unrelated)).base, master);
  });

  assert.equal(await resolveCommit(root, HEAD_REF), second);
  assert.deepEqual(await readFile(path.join(root, ".git/index")), indexBefore);
});

test("compares committed, staged and working contents in both directions", async (t) => {
  const { root, temporary, git, write, first, second } = await fixture();
  await write("src/main.txt", "base\ncommitted\nstaged\n");
  await write("src/staged.txt", "new staged file\n");
  await rename(path.join(root, "src/deleted.txt"), path.join(temporary, "deleted.txt"));
  await git("add", "-A");
  await write("src/main.txt", "base\ncommitted\nstaged\nworking\n");
  await write("src/untracked.txt", "one\ntwo");
  await write("src/binary.bin", Buffer.from([0, 1, 2, 3]));
  const indexBefore = await readFile(path.join(root, ".git/index"));

  for (const [name, base, source, added, deleted] of [
    ["commit → index", second, INDEX_REF, 1, 0],
    ["index → commit", INDEX_REF, second, 0, 1],
    ["index → worktree", INDEX_REF, WORKTREE_REF, 1, 0],
    ["worktree → index", WORKTREE_REF, INDEX_REF, 0, 1],
    ["commit → worktree", second, WORKTREE_REF, 2, 0],
    ["worktree → commit", WORKTREE_REF, second, 0, 2],
    ["older commit → worktree", first, WORKTREE_REF, 3, 0],
  ] as const) {
    await t.test(name, async () => {
      const result = await compareRefs(root, base, source);
      const main = result.changes.find((change) => change.path === "src/main.txt");
      assert.equal(main?.additions, added);
      assert.equal(main?.deletions, deleted);
      if ([base, source].includes(WORKTREE_REF)) {
        const untracked = result.changes.find((change) => change.path === "src/untracked.txt");
        assert.equal(untracked?.status, source === WORKTREE_REF ? "A" : "D");
        assert.equal(source === WORKTREE_REF ? untracked?.additions : untracked?.deletions, 2);
        assert.equal(result.changes.find((change) => change.path === "src/binary.bin")?.binary, true);
      } else {
        assert.ok(!result.changes.some((change) => change.path === "src/untracked.txt"));
      }
    });
  }

  await t.test("native staged and unstaged scopes stay separate", async () => {
    const staged = await compareRefs(root, HEAD_REF, INDEX_REF);
    assert.equal(staged.changes.find((change) => change.path === "src/staged.txt")?.status, "A");
    assert.equal(staged.changes.find((change) => change.path === "src/deleted.txt")?.status, "D");
    const unstaged = await compareRefs(root, INDEX_REF, WORKTREE_REF, false, false);
    assert.deepEqual(unstaged.changes.map((change) => change.path), ["src/main.txt"]);
  });

  await t.test("merge-base mode does not replace a selected live endpoint", async () => {
    const result = await compareRefs(root, first, INDEX_REF, true);
    assert.equal(result.base, first);
    assert.equal(result.changes.find((change) => change.path === "src/main.txt")?.additions, 2);
  });

  await t.test("diff content reads the index instead of the newer working file", async () => {
    assert.equal(await showFileAtRef(root, INDEX_REF, "src/main.txt"), "base\ncommitted\nstaged\n");
    assert.equal(await showFileAtRef(root, second, "src/main.txt"), "base\ncommitted\n");
    assert.equal(await showFileAtRef(root, INDEX_REF, "src/deleted.txt"), "");
  });

  await t.test("same endpoints give an empty comparison", async () => {
    for (const ref of [INDEX_REF, WORKTREE_REF, second]) {
      assert.deepEqual((await compareRefs(root, ref, ref)).changes, []);
    }
    assert.deepEqual((await compareRefs(root, HEAD_REF, second)).changes, []);
  });

  assert.deepEqual(await readFile(path.join(root, ".git/index")), indexBefore);
  assert.equal(await readFile(path.join(root, "src/main.txt"), "utf8"), "base\ncommitted\nstaged\nworking\n");
});

test("commit choices, branch groups and renamed paths retain their meaning", async () => {
  const { root, git, first, second } = await fixture();
  const forward = await compareRefs(root, first, second);
  const renameForward = forward.changes.find((change) => change.status === "R");
  assert.equal(renameForward?.oldPath, "src/old.txt");
  assert.equal(renameForward?.path, "src/renamed.txt");
  const backward = await compareRefs(root, second, first);
  const renameBackward = backward.changes.find((change) => change.status === "R");
  assert.equal(renameBackward?.oldPath, "src/renamed.txt");
  assert.equal(renameBackward?.path, "src/old.txt");

  await git("branch", "feature/with-slashes");
  await git("update-ref", "refs/remotes/origin/main", second);
  const branches = await listBranches(root);
  assert.equal(branches.find((branch) => branch.name === "feature/with-slashes")?.remote, false);
  assert.equal(branches.find((branch) => branch.name === "origin/main")?.remote, true);
  const [newest] = await listCommits(root, 0, 1);
  const [older] = await listCommits(root, 1, 1);
  assert.equal(newest.ref, second);
  assert.equal(newest.subject, "第二个提交");
  assert.equal(newest.author, "Branch Diff Test");
  assert.equal(older.ref, first);
  assert.equal(await verifyRef(root, "HEAD~1"), true);
  assert.equal(await verifyRef(root, "--help"), false);
});

test("a file removed from the index still compares its working content to a commit", async () => {
  const { root, git, write, second } = await fixture();
  await git("update-index", "--force-remove", "src/main.txt");
  await write("src/main.txt", "base\nnew\nmore\n");
  const indexBefore = await readFile(path.join(root, ".git/index"));
  const forward = (await compareRefs(root, second, WORKTREE_REF)).changes.find((change) => change.path === "src/main.txt");
  assert.equal(forward?.status, "M");
  assert.equal(forward.additions, 2);
  assert.equal(forward.deletions, 1);
  const reverse = (await compareRefs(root, WORKTREE_REF, second)).changes.find((change) => change.path === "src/main.txt");
  assert.equal(reverse?.status, "M");
  assert.equal(reverse.additions, 1);
  assert.equal(reverse.deletions, 2);
  await write("src/main.txt", "base\ncommitted\n");
  assert.deepEqual((await compareRefs(root, second, WORKTREE_REF)).changes, []);
  assert.deepEqual(await readFile(path.join(root, ".git/index")), indexBefore);
});
