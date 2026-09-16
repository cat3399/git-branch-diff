import { execFile } from "child_process";
import { promisify } from "util";
import { lstat, readFile, readlink } from "fs/promises";
import * as path from "path";

const execFileAsync = promisify(execFile);

// Generous buffer for `git show` on large files.
const MAX_BUFFER = 64 * 1024 * 1024;

export const HEAD_REF = "HEAD";
export const WORKTREE_REF = "~worktree";
export const INDEX_REF = "~index";

export interface GitBranch {
  name: string;
  ref: string;
  remote: boolean;
}

export interface GitCommit {
  ref: string;
  shortRef: string;
  author: string;
  date: string;
  subject: string;
}

export function isLiveRef(ref: string): boolean {
  return ref === WORKTREE_REF || ref === INDEX_REF;
}

export type ChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export interface FileChange {
  /** Single-letter status (renames/copies reduced to R/C). */
  status: ChangeStatus;
  /** Current path (the new path for renames/copies). */
  path: string;
  /** Original path for renames/copies. */
  oldPath?: string;
  /** Similarity percentage for renames/copies, when reported. */
  score?: number;
  /** Lines added (undefined for binary files). */
  additions?: number;
  /** Lines deleted (undefined for binary files). */
  deletions?: number;
  /** True when git reports the file as binary (numstat shows "-"). */
  binary?: boolean;
}

/** Per-file line counts from `git diff --numstat`. */
export interface FileStats {
  additions?: number;
  deletions?: number;
  binary: boolean;
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: MAX_BUFFER,
    // Keep raw bytes as UTF-8 text; binary blobs are handled by callers.
    encoding: "utf8",
  });
  return stdout;
}

/** Resolve the top-level directory of the repo containing `cwd`, or null. */
export async function getRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

export async function getCurrentBranch(root: string): Promise<string> {
  const out = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out.trim();
}

/** List local + remote branch names, de-duplicated, excluding HEAD pointers. */
export async function listBranches(root: string): Promise<GitBranch[]> {
  const out = await git(root, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(refname:short)%00%(symref)",
    "refs/heads",
    "refs/remotes",
  ]);
  const branches: GitBranch[] = [];
  for (const row of out.split("\n")) {
    const [ref, name, symbolic] = row.split("\0");
    if (!ref || symbolic) continue;
    branches.push({ name, ref, remote: ref.startsWith("refs/remotes/") });
  }
  return branches;
}

/** Page through all reachable commits, including a detached HEAD. */
export async function listCommits(
  root: string,
  skip = 0,
  limit = 100,
  ref?: string
): Promise<GitCommit[]> {
  const revisions = ref
    ? [await resolveCommit(root, ref)]
    : ["--all", ...((await verifyRef(root, HEAD_REF)) ? [HEAD_REF] : [])];
  const out = await git(root, [
    "log",
    ...revisions,
    "--date-order",
    `--skip=${skip}`,
    `--max-count=${limit}`,
    "--format=%H%x00%h%x00%an%x00%aI%x00%s",
    "-z",
    "--",
  ]);
  const fields = out.split("\0");
  const commits: GitCommit[] = [];
  for (let i = 0; i + 4 < fields.length; i += 5) {
    const [ref, shortRef, author, date, subject] = fields.slice(i, i + 5);
    commits.push({ ref, shortRef, author, date, subject });
  }
  return commits;
}

/** List tag names, most recent first. */
export async function listTags(root: string): Promise<string[]> {
  const out = await git(root, [
    "tag",
    "--list",
    "--sort=-creatordate",
  ]);
  return out
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** True when `ref` resolves to a commit in this repo. */
export async function verifyRef(root: string, ref: string): Promise<boolean> {
  try {
    await resolveCommit(root, ref);
    return true;
  } catch {
    return false;
  }
}

/** Resolve user input once, so both the stats and opened diff use the same commit. */
export async function resolveCommit(root: string, ref: string): Promise<string> {
  const out = await git(root, [
    "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`,
  ]);
  return out.trim();
}

export class NoMergeBaseError extends Error {}

/** Compute the common ancestor without silently changing comparison modes. */
export async function getMergeBase(
  root: string,
  source: string,
  target: string
): Promise<string> {
  try {
    const out = await git(root, ["merge-base", source, target]);
    const sha = out.trim();
    if (sha) {
      return sha;
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === 1)) throw error;
  }
  throw new NoMergeBaseError("These commits have no common ancestor. Use direct comparison to compare them.");
}

/**
 * Parse NUL-delimited `git diff --name-status --find-renames -z` output into
 * structured changes. Pure (no I/O) so it can be unit-tested directly.
 */
export function parseNameStatus(out: string): FileChange[] {
  const fields = out.split("\0");
  const changes: FileChange[] = [];
  let i = 0;
  while (i < fields.length) {
    const code = fields[i];
    if (!code) {
      i++;
      continue;
    }
    const letter = code[0] as ChangeStatus;
    const score = code.length > 1 ? parseInt(code.slice(1), 10) : undefined;

    if (letter === "R" || letter === "C") {
      // Rename/copy: status\0oldPath\0newPath
      const oldPath = fields[i + 1];
      const newPath = fields[i + 2];
      if (newPath === undefined) {
        break;
      }
      changes.push({
        status: letter,
        path: newPath,
        oldPath,
        score: Number.isNaN(score) ? undefined : score,
      });
      i += 3;
    } else {
      // status\0path
      const p = fields[i + 1];
      if (p === undefined) {
        break;
      }
      changes.push({ status: letter, path: p });
      i += 2;
    }
  }

  const unique = new Map<string, FileChange>();
  for (const change of changes) {
    if (unique.get(change.path)?.status !== "U") unique.set(change.path, change);
  }
  return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Parse NUL-delimited `git diff --numstat -z` output into a map keyed by the
 * file's current path. Normal records are `adds\tdels\tpath`; renames put an
 * empty inline path then two more fields (old, new); binaries use "-". Pure.
 */
export function parseNumstat(out: string): Map<string, FileStats> {
  const stats = new Map<string, FileStats>();
  const fields = out.split("\0");
  let i = 0;
  while (i < fields.length) {
    const field = fields[i];
    if (!field) {
      i++;
      continue;
    }
    const parts = field.split("\t");
    if (parts.length < 3) {
      i++;
      continue;
    }
    const [addsStr, delsStr] = parts;
    const inlinePath = parts.slice(2).join("\t");
    const binary = addsStr === "-" || delsStr === "-";
    const entry: FileStats = binary
      ? { binary: true }
      : {
          additions: parseInt(addsStr, 10) || 0,
          deletions: parseInt(delsStr, 10) || 0,
          binary: false,
        };

    if (inlinePath === "") {
      // Rename/copy: the next two fields are old path, then new path.
      const newPath = fields[i + 2];
      if (newPath !== undefined) {
        stats.set(newPath, entry);
      }
      i += 3;
    } else {
      stats.set(inlinePath, entry);
      i += 1;
    }
  }
  return stats;
}

/** Attach numstat line counts onto the matching name-status changes. */
export function attachStats(
  changes: FileChange[],
  stats: Map<string, FileStats>
): FileChange[] {
  for (const change of changes) {
    const s = stats.get(change.path);
    if (s) {
      change.additions = s.additions;
      change.deletions = s.deletions;
      change.binary = s.binary;
    }
  }
  return changes;
}

/**
 * Run name-status and numstat for `base` → `head` and merge them, so each
 * change carries its status and its +/- line counts.
 */
export async function listChanges(
  root: string,
  base: string,
  head: string
): Promise<FileChange[]> {
  const args = comparisonArgs(base, head);
  const [nameStatus, numstat] = await Promise.all([
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "--find-renames", "-z", ...args, "--"]),
    git(root, ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "--find-renames", "-z", ...args, "--"]),
  ]);
  return attachStats(parseNameStatus(nameStatus), parseNumstat(numstat));
}

/** Git's three endpoint types: committed tree, index, and working tree. */
function comparisonArgs(base: string, source: string): string[] {
  if (base === INDEX_REF) {
    return source === WORKTREE_REF ? [] : ["--cached", "-R", source];
  }
  if (source === INDEX_REF) {
    return base === WORKTREE_REF ? ["-R"] : ["--cached", base];
  }
  if (source === WORKTREE_REF) return [base];
  if (base === WORKTREE_REF) return ["-R", source];
  return [base, source];
}

export interface Comparison {
  /** The selected left commit, before applying merge-base mode. */
  target: string;
  base: string;
  source: string;
  mergeBase?: string;
  changes: FileChange[];
}

export async function compareRefs(
  root: string,
  baseRef: string,
  sourceRef: string,
  useMergeBase = false,
  includeUntracked = true
): Promise<Comparison> {
  let [base, source] = await Promise.all(
    [baseRef, sourceRef].map((ref) =>
      isLiveRef(ref) ? Promise.resolve(ref) : resolveCommit(root, ref)
    )
  );
  const target = base;
  let mergeBase: string | undefined;

  // Merge-base mode only applies to two committed revisions.
  if (useMergeBase && !isLiveRef(base) && !isLiveRef(source)) {
    mergeBase = base === source ? base : await getMergeBase(root, source, base);
    base = mergeBase;
  }
  if (base === source) return { target, base, source, mergeBase, changes: [] };
  let changes = await listChanges(root, base, source);
  if (includeUntracked && [base, source].includes(WORKTREE_REF)) {
    const added = source === WORKTREE_REF;
    const other = added ? base : source;
    const untracked = await listUntracked(root);
    for (const filePath of untracked) {
      const existing = changes.find((change) => change.path === filePath);
      if (existing && other !== INDEX_REF && existing.status === (added ? "D" : "A")) {
        // diff-index treats a path removed from the index as absent even if it
        // still exists on disk. Compare the committed blob to that file directly.
        const output = await git(root, [
          "diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z",
          `${other}:${filePath}`, "--", filePath,
        ]);
        const stats = parseNumstat(output).get(filePath);
        if (!stats) {
          changes = changes.filter((change) => change !== existing);
        } else {
          existing.status = "M";
          existing.binary = stats.binary;
          existing.additions = added ? stats.additions : stats.deletions;
          existing.deletions = added ? stats.deletions : stats.additions;
        }
        continue;
      }
      if (existing) continue;
      const stats = await readUntrackedStats(root, filePath);
      changes.push({
        path: filePath,
        status: added ? "A" : "D",
        binary: stats.binary,
        additions: stats.binary ? undefined : added ? stats.additions : 0,
        deletions: stats.binary ? undefined : added ? 0 : stats.additions,
      });
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));
  }
  return { target, base, source, mergeBase, changes };
}

/** Count untracked text too, including a final line without a newline. */
async function readUntrackedStats(root: string, filePath: string): Promise<FileStats> {
  const absolute = path.join(root, filePath);
  const stat = await lstat(absolute);
  const content = stat.isSymbolicLink()
    ? Buffer.from(await readlink(absolute))
    : await readFile(absolute);
  if (content.subarray(0, 8000).includes(0)) return { binary: true };
  let lines = 0;
  for (const byte of content) {
    if (byte === 10) lines++;
  }
  if (content.length && content[content.length - 1] !== 10) lines++;
  return { additions: lines, deletions: 0, binary: false };
}

/** List untracked (but not ignored) files as repo-relative paths. */
export async function listUntracked(root: string): Promise<string[]> {
  const out = await git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  return out.split("\0").filter(Boolean);
}

/**
 * Return the contents of `path` at `ref`. Returns "" when the blob does not
 * exist at that ref (e.g. the added side of a new file or deleted side).
 */
export async function showFileAtRef(
  root: string,
  ref: string,
  path: string
): Promise<string> {
  if (!ref) return "";
  let object = `${ref}:${path}`;
  if (ref === INDEX_REF) {
    const staged = await git(root, ["ls-files", "--stage", "-z", "--", ":(literal)" + path]);
    const entry = staged.split("\0").find((line) => /^\d+ [a-f0-9]+ 0\t/.test(line));
    if (!entry) return "";
    object = entry.split(" ")[1];
  }
  return git(root, ["cat-file", "blob", object]);
}
