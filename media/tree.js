(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const collapsed = new Set(saved.collapsed || []);
  let selected = saved.selected;
  let model;
  let visibleRows = [];
  const container = document.getElementById("repositories");
  const keyOf = (root, id) => JSON.stringify([root, id]);
  const persist = () => vscode.setState({ collapsed: [...collapsed], selected });

  function icon(name) {
    const names = { arrow: "chevron-right", open: "go-to-file" };
    const node = element("span", "icon codicon codicon-" + names[name]);
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  function fileIcon(entry, expanded) {
    const asset = expanded ? entry.expandedIcon : entry.icon;
    if (!asset) return undefined;
    const node = element("span", "theme-icon");
    node.setAttribute("aria-hidden", "true");
    if (asset.uri) {
      const image = element("img");
      image.src = asset.uri;
      image.alt = "";
      node.append(image);
    } else {
      node.textContent = asset.character;
      node.style.fontFamily = asset.family;
      node.style.fontSize = asset.size;
      if (asset.color) node.style.color = asset.color;
    }
    return node;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function send(action, repository, entry) {
    vscode.postMessage({ action, repoRoot: repository.root, entryId: entry?.id });
  }

  function selectRow(key, focus = true) {
    selected = key;
    for (const row of visibleRows) {
      const active = row.dataset.key === key;
      row.classList.toggle("selected", active);
      row.setAttribute("aria-selected", String(active));
      row.tabIndex = active ? 0 : -1;
      if (active && focus) row.focus({ preventScroll: true });
    }
    persist();
  }

  function toggleFolder(key) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    selected = key;
    persist();
    render(true);
  }

  function addRows(tree, entries, repository, depth = 0, parentKey = "") {
    const number = new Intl.NumberFormat(model.locale);
    for (const entry of entries) {
      const key = keyOf(repository.root, entry.id);
      const isFolder = entry.kind === "folder";
      const expanded = isFolder && !collapsed.has(key);
      const row = element("div", "row");
      row.style.setProperty("--depth", String(depth));
      row.dataset.key = key;
      row.dataset.parent = parentKey;
      row.dataset.kind = entry.kind;
      row.dataset.vscodeContext = JSON.stringify({
        webviewSection: entry.kind,
        branchDiffLocalRepo: repository.root,
        branchDiffLocalEntry: entry.id,
        preventDefaultContextMenuItems: true,
      });
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth + 1));
      row.setAttribute("aria-label", entry.path);
      if (isFolder) row.setAttribute("aria-expanded", String(expanded));
      row.tabIndex = -1;

      const twisty = element("span", "twisty" + (expanded ? " expanded" : ""));
      if (isFolder) twisty.append(icon("arrow"));
      row.append(twisty);
      const themedIcon = fileIcon(entry, expanded);
      if (themedIcon) row.append(themedIcon);
      const label = element("span", "label", entry.label);
      label.title = entry.path;
      row.append(label);
      const counts = element("span", "counts");
      if (entry.binaries !== entry.files) {
        counts.append(
          element("span", "additions", "+" + number.format(entry.additions)),
          element("span", "deletions", "−" + number.format(entry.deletions))
        );
      }
      if (entry.binaries) counts.append(element("span", "", number.format(entry.binaries) + " " + model.labels.binary));
      row.append(counts, element("span", "spacer"));

      if (!isFolder) {
        const open = element("button", "icon-button open-file");
        open.type = "button";
        open.tabIndex = -1;
        open.title = model.labels.openFile;
        open.setAttribute("aria-label", model.labels.openFile);
        open.append(icon("open"));
        open.addEventListener("click", (event) => {
          event.stopPropagation();
          selectRow(key, false);
          send("openFile", repository, entry);
        });
        row.append(open);
      }
      const status = element("span", "status", isFolder ? "" : entry.change.status);
      if (!isFolder) status.dataset.status = entry.change.status;
      row.append(status);
      row.addEventListener("click", () => {
        if (isFolder) toggleFolder(key);
        else {
          selectRow(key);
          send("openChange", repository, entry);
        }
      });
      row.addEventListener("contextmenu", () => selectRow(key, false));
      row.addEventListener("keydown", (event) => {
        const index = visibleRows.indexOf(row);
        let target;
        switch (event.key) {
          case "ArrowDown": target = visibleRows[index + 1]; break;
          case "ArrowUp": target = visibleRows[index - 1]; break;
          case "Home": target = visibleRows[0]; break;
          case "End": target = visibleRows[visibleRows.length - 1]; break;
          case "ArrowRight":
            if (isFolder && !expanded) toggleFolder(key);
            else if (isFolder) target = visibleRows[index + 1];
            break;
          case "ArrowLeft":
            if (expanded) toggleFolder(key);
            else target = visibleRows.find((item) => item.dataset.key === parentKey);
            break;
          case "Enter":
          case " ":
            if (isFolder) toggleFolder(key);
            else send(event.shiftKey ? "openFile" : "openChange", repository, entry);
            break;
          default: return;
        }
        event.preventDefault();
        if (target) {
          selectRow(target.dataset.key);
          target.scrollIntoView({ block: "nearest" });
        }
      });
      tree.append(row);
      visibleRows.push(row);
      if (expanded) addRows(tree, entry.children, repository, depth + 1, key);
    }
  }

  function render(focus = false) {
    if (!model) return;
    const hadFocus = Boolean(document.activeElement?.closest(".row"));
    const scroll = window.scrollY;
    container.replaceChildren();
    visibleRows = [];
    if (!model.repositories.length) {
      container.append(element("p", "message", model.labels.noRepos));
      return;
    }
    for (const repository of model.repositories) {
      const section = element("section", "repository");
      section.setAttribute("aria-busy", String(repository.loading));
      if (model.repositories.length > 1) {
        const heading = element("div", "repo-name", repository.name);
        heading.title = repository.base + " ↔ " + repository.source;
        section.append(heading);
      }
      if (repository.comparison) {
        const comparison = element("div", "comparison", repository.comparison);
        comparison.title = repository.comparisonDetails;
        section.append(comparison);
      }
      if (!repository.error && (repository.loading || repository.summary)) {
        const summary = element("div", "summary", repository.loading ? model.labels.loading : repository.summary);
        if (!repository.loading && repository.totals.files > repository.totals.binaries) {
          const number = new Intl.NumberFormat(model.locale);
          summary.append(
            " · ", element("span", "additions", "+" + number.format(repository.totals.additions)),
            " ", element("span", "deletions", "−" + number.format(repository.totals.deletions))
          );
        }
        section.append(summary);
      }
      if (repository.error) {
        const error = element("p", "message error", repository.error);
        error.setAttribute("role", "alert");
        section.append(error);
      } else if (!repository.selected) {
        section.append(element("p", "message", model.labels.select));
      } else if (repository.roots.length) {
        const tree = element("div", "tree");
        tree.setAttribute("role", "tree");
        tree.setAttribute("aria-label", model.labels.changedFiles + " · " + repository.name);
        addRows(tree, repository.roots, repository);
        section.append(tree);
      }
      container.append(section);
    }
    if (!visibleRows.some((row) => row.dataset.key === selected)) {
      selected = visibleRows[0]?.dataset.key;
    }
    selectRow(selected, focus || hadFocus);
    window.scrollTo(0, scroll);
  }

  const loadedFonts = new Set();
  window.addEventListener("message", ({ data }) => {
    if (data?.type !== "tree") return;
    for (const font of data.fonts || []) {
      const key = JSON.stringify(font);
      if (loadedFonts.has(key)) continue;
      loadedFonts.add(key);
      const source = font.sources.map((item) => "url(" + JSON.stringify(item.uri) + ") format(" + JSON.stringify(item.format) + ")").join(", ");
      const face = new FontFace(font.family, source, { weight: font.weight, style: font.style });
      document.fonts.add(face);
      void face.load().catch((error) => console.warn("File icon font:", error));
    }
    model = data;
    render();
  });
  vscode.postMessage({ action: "ready" });
})();
