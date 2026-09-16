import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFileTree } from "./fileTree";
import { FileChange } from "./git";

test("every folder keeps recursive line totals, including compacted folder chains", () => {
  const changes: FileChange[] = [
    { status: "M", path: "app/services/chat/a.py", additions: 10, deletions: 3 },
    { status: "A", path: "app/services/chat/b.py", additions: 5, deletions: 0 },
    { status: "M", path: "app/schema.py", additions: 2, deletions: 1 },
    { status: "A", path: "app/services/chat/image.png", binary: true },
  ];
  const { roots, totals } = buildFileTree(changes);
  assert.deepEqual(totals, { files: 4, additions: 17, deletions: 4, binaries: 1 });
  const app = roots[0];
  assert.equal(app.kind, "folder");
  if (app.kind !== "folder") return;
  assert.equal(app.additions, 17);
  assert.equal(app.deletions, 4);
  const chat = app.children[0];
  assert.equal(chat.kind, "folder");
  assert.equal(chat.label, "services/chat");
  assert.equal(chat.additions, 15);
  assert.equal(chat.deletions, 3);
  assert.equal(chat.files, 3);
  assert.equal(chat.binaries, 1);

  const flat = buildFileTree(changes, false);
  assert.ok(flat.roots.every((entry) => entry.kind === "file"));
  assert.deepEqual(flat.totals, totals);
});
