import * as path from "path";
import * as vscode from "vscode";
import { parse } from "jsonc-parser";
import { FileTreeEntry } from "./fileTree";

interface IconDefinition {
  iconPath?: string;
  fontCharacter?: string;
  fontId?: string;
  fontColor?: string;
  fontSize?: string;
}

interface IconFont {
  id: string;
  src: { path: string; format: string }[];
  weight?: string;
  style?: string;
  size?: string;
}

interface Associations {
  file?: string;
  folder?: string;
  folderExpanded?: string;
  fileNames?: Record<string, string>;
  fileExtensions?: Record<string, string>;
  languageIds?: Record<string, string>;
  folderNames?: Record<string, string>;
  folderNamesExpanded?: Record<string, string>;
}

interface Theme extends Associations {
  iconDefinitions: Record<string, IconDefinition>;
  fonts?: IconFont[];
  light?: Associations;
  highContrast?: Associations;
}

export interface IconAsset {
  uri?: string;
  character?: string;
  family?: string;
  size?: string;
  color?: string;
}

export interface WebviewIconFont {
  family: string;
  sources: { uri: string; format: string }[];
  weight: string;
  style: string;
}

/** Resolve the installed file-icon theme's assets without copying or redrawing them. */
export class FileIcons {
  private readonly associations: Associations;
  private readonly languageNames = new Map<string, string>();
  private readonly languageExtensions = new Map<string, string>();

  private constructor(
    readonly resourceRoot: vscode.Uri,
    private readonly themeUri: vscode.Uri,
    private readonly theme: Theme
  ) {
    const kind = vscode.window.activeColorTheme.kind;
    const variant = kind === vscode.ColorThemeKind.HighContrast
      ? theme.highContrast
      : kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
        ? theme.light
        : undefined;
    this.associations = { ...theme, ...variant };
    // Variants override individual associations, not the entire name/extension maps.
    for (const key of ["fileNames", "fileExtensions", "languageIds", "folderNames", "folderNamesExpanded"] as const) {
      this.associations[key] = { ...theme[key], ...variant?.[key] };
    }
    for (const extension of vscode.extensions.all) {
      const languages: { id: string; filenames?: string[]; extensions?: string[] }[] =
        extension.packageJSON.contributes?.languages ?? [];
      for (const language of languages) {
        for (const name of language.filenames ?? []) this.languageNames.set(name.toLowerCase(), language.id);
        for (const suffix of language.extensions ?? []) this.languageExtensions.set(suffix.toLowerCase(), language.id);
      }
    }
  }

  static async load(): Promise<FileIcons | undefined> {
    const id = vscode.workspace.getConfiguration("workbench").get<string | null>("iconTheme", "vs-seti");
    if (!id) return undefined;
    for (const extension of vscode.extensions.all) {
      const themes: { id: string; path: string }[] = extension.packageJSON.contributes?.iconThemes ?? [];
      const contribution = themes.find((theme) => theme.id === id);
      if (!contribution) continue;
      const themeUri = vscode.Uri.joinPath(extension.extensionUri, contribution.path);
      const content = await vscode.workspace.fs.readFile(themeUri);
      const theme: Theme = parse(Buffer.from(content).toString("utf8"));
      if (!theme?.iconDefinitions) return undefined;
      return new FileIcons(extension.extensionUri, themeUri, theme);
    }
    return undefined;
  }

  fonts(webview: vscode.Webview): WebviewIconFont[] {
    return (this.theme.fonts ?? []).map((font) => ({
      family: this.fontFamily(font),
      sources: font.src.map((source) => ({ uri: this.assetUri(webview, source.path), format: source.format })),
      weight: font.weight ?? "normal",
      style: font.style ?? "normal",
    }));
  }

  icon(webview: vscode.Webview, entry: FileTreeEntry, expanded = false): IconAsset | undefined {
    const id = entry.kind === "folder" ? this.folderId(entry.path, expanded) : this.fileId(entry.path);
    const definition = id && this.theme.iconDefinitions[id];
    if (!definition) return undefined;
    if (definition.iconPath) return { uri: this.assetUri(webview, definition.iconPath) };
    if (!definition.fontCharacter) return undefined;
    const fonts = this.theme.fonts ?? [];
    const font = definition.fontId ? fonts.find((font) => font.id === definition.fontId) : fonts[0];
    if (!font) return undefined;
    return {
      character: definition.fontCharacter.replace(/\\([\da-f]{1,6})\s?/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16))),
      family: this.fontFamily(font),
      size: definition.fontSize ?? font.size ?? "100%",
      color: definition.fontColor,
    };
  }

  private assetUri(webview: vscode.Webview, relativePath: string): string {
    return webview.asWebviewUri(vscode.Uri.joinPath(this.themeUri, "..", relativePath)).toString();
  }

  private fontFamily(font: IconFont): string {
    return "branch-diff-" + Buffer.from(this.themeUri.toString() + ":" + font.id).toString("base64url");
  }

  private folderId(filePath: string, expanded: boolean): string | undefined {
    const name = path.posix.basename(filePath).toLowerCase();
    const associations = this.associations;
    if (expanded) {
      return associations.folderNamesExpanded?.[name]
        ?? associations.folderNames?.[name]
        ?? associations.folderExpanded
        ?? associations.folder;
    }
    return associations.folderNames?.[name] ?? associations.folder;
  }

  private fileId(filePath: string): string | undefined {
    const name = path.posix.basename(filePath).toLowerCase();
    const parent = path.posix.basename(path.posix.dirname(filePath)).toLowerCase();
    const associations = this.associations;
    const byName = associations.fileNames?.[parent + "/" + name] ?? associations.fileNames?.[name];
    if (byName) return byName;
    const suffixes = name.split(".").slice(1).map((_, index, parts) => parts.slice(index).join("."));
    for (const suffix of suffixes) {
      const byExtension = associations.fileExtensions?.[parent + "/" + suffix] ?? associations.fileExtensions?.[suffix];
      if (byExtension) return byExtension;
    }
    let languageId = this.languageNames.get(name);
    for (const suffix of suffixes) {
      languageId ??= this.languageExtensions.get("." + suffix);
    }
    return (languageId && associations.languageIds?.[languageId]) || associations.file;
  }
}
