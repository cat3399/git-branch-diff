import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNameStatus, parseNumstat, attachStats } from "./git";

// Helper: build NUL-delimited `git diff --name-status -z` output from fields.
const z = (...fields: string[]) => fields.join("\0");

test("parses added, modified and deleted entries", () => {
  const out = z("A", "added.txt", "M", "mod.txt", "D", "gone.txt", "");
  const changes = parseNameStatus(out);
  assert.deepEqual(
    changes.map((c) => [c.status, c.path]),
    [
      ["A", "added.txt"],
      ["D", "gone.txt"],
      ["M", "mod.txt"],
    ]
  );
});

test("parses renames with old path and similarity score", () => {
  const out = z("R100", "old/name.txt", "new/name.txt", "");
  const [c] = parseNameStatus(out);
  assert.equal(c.status, "R");
  assert.equal(c.path, "new/name.txt");
  assert.equal(c.oldPath, "old/name.txt");
  assert.equal(c.score, 100);
});

test("parses copies as C with an old path", () => {
  const out = z("C75", "src.txt", "copy.txt", "");
  const [c] = parseNameStatus(out);
  assert.equal(c.status, "C");
  assert.equal(c.path, "copy.txt");
  assert.equal(c.oldPath, "src.txt");
  assert.equal(c.score, 75);
});

test("handles a mix of renames and plain changes", () => {
  const out = z(
    "A",
    "added.txt",
    "R100",
    "oldname.txt",
    "newname.txt",
    "M",
    "mod.txt",
    ""
  );
  const changes = parseNameStatus(out);
  assert.equal(changes.length, 3);
  const rename = changes.find((c) => c.status === "R");
  assert.equal(rename?.oldPath, "oldname.txt");
  assert.equal(rename?.path, "newname.txt");
});

test("preserves paths containing spaces", () => {
  const out = z("M", "dir with spaces/my file.txt", "");
  const [c] = parseNameStatus(out);
  assert.equal(c.path, "dir with spaces/my file.txt");
});

test("returns an empty array for empty output", () => {
  assert.deepEqual(parseNameStatus(""), []);
});

test("sorts results by path", () => {
  const out = z("M", "zeta.txt", "M", "alpha.txt", "M", "mid.txt", "");
  const paths = parseNameStatus(out).map((c) => c.path);
  assert.deepEqual(paths, ["alpha.txt", "mid.txt", "zeta.txt"]);
});

// --- numstat ---

test("parses numstat for normal files", () => {
  const out = z("2\t0\tadded.txt", "2\t1\tmod.txt", "");
  const stats = parseNumstat(out);
  assert.deepEqual(stats.get("added.txt"), {
    additions: 2,
    deletions: 0,
    binary: false,
  });
  assert.deepEqual(stats.get("mod.txt"), {
    additions: 2,
    deletions: 1,
    binary: false,
  });
});

test("preserves tabs inside a numstat file path", () => {
  const stats = parseNumstat(z("2\t1\tdirectory/a\tb.txt", ""));
  assert.equal(stats.get("directory/a\tb.txt")?.additions, 2);
});

test("parses numstat rename records keyed by the new path", () => {
  // `0\t0\t` then old, then new — the empty inline path marks a rename.
  const out = z("0\t0\t", "oldname.txt", "newname.txt", "");
  const stats = parseNumstat(out);
  assert.deepEqual(stats.get("newname.txt"), {
    additions: 0,
    deletions: 0,
    binary: false,
  });
  assert.equal(stats.has("oldname.txt"), false);
});

test("marks binary files (numstat '-') as binary with no counts", () => {
  const out = z("-\t-\timage.png", "");
  const stats = parseNumstat(out);
  assert.deepEqual(stats.get("image.png"), { binary: true });
});

test("attachStats merges counts onto changes by path", () => {
  const changes = parseNameStatus(z("A", "added.txt", "M", "mod.txt", ""));
  const stats = parseNumstat(z("2\t0\tadded.txt", "5\t3\tmod.txt", ""));
  attachStats(changes, stats);
  const added = changes.find((c) => c.path === "added.txt")!;
  const mod = changes.find((c) => c.path === "mod.txt")!;
  assert.equal(added.additions, 2);
  assert.equal(mod.deletions, 3);
  assert.equal(mod.binary, false);
});
