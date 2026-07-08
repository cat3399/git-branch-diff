import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

// Generous buffer for `git show` on large files.
const MAX_BUFFER = 64 * 1024 * 1024;

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
export async function listBranches(root: string): Promise<string[]> {
  const out = await git(root, [
    "branch",
    "--all",
    "--format=%(refname:short)",
  ]);
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const raw of out.split("\n")) {
    const name = raw.trim();
    if (!name) {
      continue;
    }
    // Skip symbolic refs like "origin/HEAD".
    if (name.endsWith("/HEAD")) {
      continue;
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    branches.push(name);
  }
  return branches;
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
    await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the diff base for 3-dot behavior: the merge-base of source and target.
 * Falls back to the target ref itself if no merge-base exists (unrelated histories).
 */
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
  } catch {
    // Fall through to using the target directly.
  }
  return target;
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

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
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
    const [addsStr, delsStr, inlinePath] = parts;
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
  // -z gives NUL-delimited fields so paths with spaces/newlines are safe.
  const [nameStatus, numstat] = await Promise.all([
    git(root, ["diff", "--name-status", "--find-renames", "-z", base, head]),
    git(root, ["diff", "--numstat", "--find-renames", "-z", base, head]),
  ]);
  return attachStats(parseNameStatus(nameStatus), parseNumstat(numstat));
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
 * List changes between `base` and the current working tree (staged + unstaged),
 * optionally adding untracked files as `A`. Used when the source is the working
 * tree rather than a committed ref.
 */
export async function listWorkingChanges(
  root: string,
  base: string,
  includeUntracked: boolean
): Promise<FileChange[]> {
  // Omitting a second ref makes git diff the base against the working tree.
  const [nameStatus, numstat] = await Promise.all([
    git(root, ["diff", "--name-status", "--find-renames", "-z", base]),
    git(root, ["diff", "--numstat", "--find-renames", "-z", base]),
  ]);
  const changes = attachStats(parseNameStatus(nameStatus), parseNumstat(numstat));

  if (includeUntracked) {
    const known = new Set(changes.map((c) => c.path));
    for (const p of await listUntracked(root)) {
      if (!known.has(p)) {
        changes.push({ status: "A", path: p });
      }
    }
    changes.sort((a, b) => a.path.localeCompare(b.path));
  }
  return changes;
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
  try {
    return await git(root, ["show", `${ref}:${path}`]);
  } catch {
    return "";
  }
}
