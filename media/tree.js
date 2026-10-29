(() => {
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const collapsed = new Set(saved.collapsed || []);
  const selected = new Set(Array.isArray(saved.selected) ? saved.selected : saved.selected ? [saved.selected] : []);
  let focused = saved.focused || [...selected][0];
  let anchor = saved.anchor || focused;
  let model;
  let visibleRows = [];
  const container = document.getElementById("repositories");
  const keyOf = (root, id) => JSON.stringify([root, id]);
  const isMac = navigator.platform.includes("Mac");
  const toggleModifier = (event) => isMac ? event.metaKey : event.ctrlKey;
  const persist = () => vscode.setState({ collapsed: [...collapsed], selected: [...selected], focused, anchor });

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

  function updateSelection(focus = false) {
    for (const row of visibleRows) {
      const picked = selected.has(row.dataset.key);
      const active = row.dataset.key === focused;
      row.classList.toggle("selected", picked);
      row.setAttribute("aria-selected", String(picked));
      row.tabIndex = active ? 0 : -1;
      if (active && focus) row.focus({ preventScroll: true });
    }
    persist();
  }

  function selectRow(key, { extend = false, toggle = false, focus = true } = {}) {
    const index = visibleRows.findIndex((row) => row.dataset.key === key);
    if (index < 0) return;
    if (extend) {
      let start = visibleRows.findIndex((row) => row.dataset.key === anchor);
      if (start < 0) {
        anchor = focused || key;
        start = visibleRows.findIndex((row) => row.dataset.key === anchor);
      }
      if (start < 0) start = index;
      if (!toggle) selected.clear();
      for (const row of visibleRows.slice(Math.min(start, index), Math.max(start, index) + 1)) {
        selected.add(row.dataset.key);
      }
    } else if (toggle) {
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      anchor = key;
    } else {
      selected.clear();
      selected.add(key);
      anchor = key;
    }
    focused = key;
    updateSelection(focus);
  }

  function toggleFolder(key) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    focused = key;
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
      row.dataset.repoRoot = repository.root;
      row.dataset.entryId = entry.id;
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
          if (isMac && event.ctrlKey) return;
          const multi = event.shiftKey || toggleModifier(event);
          selectRow(key, { extend: event.shiftKey, toggle: toggleModifier(event), focus: Boolean(multi) });
          if (!multi) send("openFile", repository, entry);
        });
        row.append(open);
      }
      const status = element("span", "status", isFolder ? "" : entry.change.status);
      if (!isFolder) status.dataset.status = entry.change.status;
      row.append(status);
      row.addEventListener("click", (event) => {
        if (isMac && event.ctrlKey) return;
        selectRow(key, { extend: event.shiftKey, toggle: toggleModifier(event) });
        if (event.shiftKey || toggleModifier(event)) return;
        if (isFolder) toggleFolder(key);
        else send("openChange", repository, entry);
      });
      row.addEventListener("contextmenu", () => {
        if (selected.has(key)) {
          focused = key;
          updateSelection();
        } else {
          selectRow(key, { focus: false });
        }
        const context = JSON.parse(row.dataset.vscodeContext);
        context.branchDiffLocalSelection = visibleRows
          .filter((item) => selected.has(item.dataset.key))
          .map((item) => ({ repoRoot: item.dataset.repoRoot, entryId: item.dataset.entryId }));
        row.dataset.vscodeContext = JSON.stringify(context);
      });
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
          case " ":
            if (event.shiftKey || toggleModifier(event)) {
              selectRow(key, { extend: event.shiftKey, toggle: toggleModifier(event) });
              break;
            }
            if (isFolder) toggleFolder(key);
            else send("openChange", repository, entry);
            break;
          case "Enter":
            if (isFolder) toggleFolder(key);
            else send(event.shiftKey ? "openFile" : "openChange", repository, entry);
            break;
          default: return;
        }
        event.preventDefault();
        if (target) {
          if (toggleModifier(event) && !event.shiftKey) {
            focused = target.dataset.key;
            updateSelection(true);
          } else {
            selectRow(target.dataset.key, { extend: event.shiftKey, toggle: toggleModifier(event) });
          }
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
        tree.setAttribute("aria-multiselectable", "true");
        tree.setAttribute("aria-label", model.labels.changedFiles + " · " + repository.name);
        addRows(tree, repository.roots, repository);
        section.append(tree);
      }
      container.append(section);
    }
    const visibleKeys = new Set(visibleRows.map((row) => row.dataset.key));
    const hadSelection = selected.size > 0;
    for (const key of selected) {
      if (!visibleKeys.has(key)) selected.delete(key);
    }
    if (!visibleKeys.has(focused)) {
      focused = [...selected][0] || visibleRows[0]?.dataset.key;
    }
    if (hadSelection && !selected.size && focused) selected.add(focused);
    if (!visibleKeys.has(anchor)) anchor = focused;
    updateSelection(focus || hadFocus);
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
