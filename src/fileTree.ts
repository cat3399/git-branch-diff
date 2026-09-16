import * as path from "path";
import { FileChange } from "./git";

export interface ChangeTotals {
  files: number;
  additions: number;
  deletions: number;
  binaries: number;
}

interface TreeEntry extends ChangeTotals {
  id: string;
  label: string;
  path: string;
}

export interface FileEntry extends TreeEntry {
  kind: "file";
  change: FileChange;
}

export interface FolderEntry extends TreeEntry {
  kind: "folder";
  children: FileTreeEntry[];
}

export type FileTreeEntry = FileEntry | FolderEntry;

interface FolderBuilder extends ChangeTotals {
  label: string;
  path: string;
  folders: Map<string, FolderBuilder>;
  children: FileEntry[];
}

function folder(label: string, folderPath: string): FolderBuilder {
  return {
    label, path: folderPath, folders: new Map(), children: [],
    files: 0, additions: 0, deletions: 0, binaries: 0,
  };
}

function addTotals(target: ChangeTotals, source: ChangeTotals): void {
  target.files += source.files;
  target.additions += source.additions;
  target.deletions += source.deletions;
  target.binaries += source.binaries;
}

/** Accumulate every ancestor while inserting, so collapsed folders retain totals. */
export function buildFileTree(
  changes: FileChange[],
  groupByFolder = true
): { roots: FileTreeEntry[]; totals: ChangeTotals } {
  const root = folder("", "");
  for (const change of changes) {
    const file: FileEntry = {
      kind: "file",
      id: "file:" + change.path,
      label: groupByFolder ? path.posix.basename(change.path) : change.path,
      path: change.path,
      change,
      files: 1,
      additions: change.additions ?? 0,
      deletions: change.deletions ?? 0,
      binaries: change.binary ? 1 : 0,
    };
    let parent = root;
    addTotals(parent, file);
    const directory = path.posix.dirname(change.path);
    if (groupByFolder && directory !== ".") {
      for (const segment of directory.split("/")) {
        let child = parent.folders.get(segment);
        if (!child) {
          child = folder(segment, parent.path ? parent.path + "/" + segment : segment);
          parent.folders.set(segment, child);
        }
        addTotals(child, file);
        parent = child;
      }
    }
    parent.children.push(file);
  }
  return {
    roots: convertChildren(root),
    totals: {
      files: root.files,
      additions: root.additions,
      deletions: root.deletions,
      binaries: root.binaries,
    },
  };
}

function convertChildren(parent: FolderBuilder): FileTreeEntry[] {
  const folders: FolderEntry[] = [];
  for (const original of parent.folders.values()) {
    let current = original;
    let label = current.label;
    while (current.folders.size === 1 && current.children.length === 0) {
      const only = current.folders.values().next().value;
      if (!only) break;
      current = only;
      label += "/" + current.label;
    }
    folders.push({
      kind: "folder",
      id: "folder:" + current.path,
      path: current.path,
      label,
      files: current.files,
      additions: current.additions,
      deletions: current.deletions,
      binaries: current.binaries,
      children: convertChildren(current),
    });
  }
  folders.sort((a, b) => a.label.localeCompare(b.label));
  const files = parent.children.sort((a, b) => a.label.localeCompare(b.label));
  return [...folders, ...files];
}
