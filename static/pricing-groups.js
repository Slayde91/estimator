"use strict";

(() => {
  let active = null;
  let nextId = 0;
  const captions = new WeakMap();

  function node(tag, className = "") {
    const element = document.createElement(tag);
    element.className = className;
    return element;
  }

  function translate(source) {
    return window.CeasefireI18n?.translate?.(source) ?? source;
  }

  function button(className, text) {
    const element = node("button", className);
    element.type = "button";
    element.textContent = text;
    return element;
  }

  function place(popup, anchor) {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const width = Math.min(Math.max(252, rect.width), window.innerWidth - 2 * margin);
    const aligned = getComputedStyle(anchor).direction === "rtl" ? rect.right - width : rect.left;
    const left = Math.min(Math.max(margin, aligned), window.innerWidth - margin - width);
    const below = window.innerHeight - rect.bottom - gap - margin;
    const above = rect.top - gap - margin;
    const openAbove = below < 230 && above > below;
    popup.style.width = `${width}px`;
    popup.style.left = `${left}px`;
    popup.style.maxHeight = `${Math.max(0, Math.min(350, openAbove ? above : below))}px`;
    popup.style.top = openAbove ? "auto" : `${rect.bottom + gap}px`;
    popup.style.bottom = openAbove ? `${window.innerHeight - rect.top + gap}px` : "auto";
  }

  function close() {
    active?.close();
  }

  function create({label, itemName, options, selected = [], placeholder = "Choose…", onChange, disabled = false, multiple = true}) {
    const root = node("div", "pricing-group-picker");
    const add = button("pricing-group-add", "+");
    const trigger = button("pricing-group-trigger", "");
    const caption = node("span", "pricing-group-caption");
    const chevron = node("span", "pricing-group-chevron");
    const choices = new Map(options.map(option => [option.value, option]));
    let saved = selected.slice();

    root.dataset.priceField = label;
    add.disabled = trigger.disabled = disabled || !options.length;
    add.setAttribute("aria-haspopup", "dialog");
    chevron.setAttribute("aria-hidden", "true");
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    trigger.append(caption, chevron);
    root.append(add, trigger);

    function setCaption() {
      const names = [...new Set(saved)].map(value => {
        const option = choices.get(value);
        return option ? translate(option.label) : value;
      });
      const summary = names.join(", ");
      const field = translate(label);
      caption.textContent = summary || translate(placeholder);
      trigger.setAttribute("aria-label", `${itemName}: ${field}`);
      trigger.title = summary || field;
      add.setAttribute("aria-label", `${translate("Add")}: ${itemName} — ${field}`);
      add.title = translate("Add");
    }
    setCaption();
    captions.set(root, setCaption);

    function open(origin, preferNew) {
      if (origin.disabled || !root.isConnected) return;
      if (active?.root === root) {
        close();
        return;
      }
      close();
      setCaption();
      const popup = node("div", "pricing-group-popup");
      const list = node("div", "pricing-group-options");
      const error = node("p", "pricing-group-error");
      const actions = node("div", "pricing-group-actions");
      const cancel = button("button secondary", translate("Cancel"));
      const apply = button("button primary", translate("Apply"));
      const pending = new Set(saved);
      const boxes = [];
      const id = `pricing-group-choices-${++nextId}`;
      popup.id = id;
      popup.dataset.pricingGroupField = label;
      popup.setAttribute("role", "dialog");
      popup.setAttribute("aria-label", trigger.getAttribute("aria-label"));
      error.setAttribute("role", "alert");
      error.hidden = true;
      apply.disabled = true;

      function nextSelection() {
        const retained = saved.filter(value => pending.has(value));
        return [...retained, ...options.map(option => option.value).filter(value => pending.has(value) && !saved.includes(value))];
      }

      for (const {value, label: optionLabel} of options) {
        const row = node("label", "pricing-group-choice");
        const checkbox = node("input");
        const text = node("span");
        checkbox.type = "checkbox";
        checkbox.value = value;
        checkbox.checked = pending.has(value);
        text.textContent = translate(optionLabel);
        boxes.push(checkbox);
        row.append(checkbox, text);
        list.append(row);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked && !multiple) {
            pending.clear();
            for (const other of boxes) if (other !== checkbox) other.checked = false;
          }
          if (checkbox.checked) pending.add(value);
          else pending.delete(value);
          const next = nextSelection();
          error.hidden = true;
          apply.disabled = (!multiple && next.length !== 1)
            || (next.length === saved.length && next.every((key, index) => key === saved[index]));
        });
      }

      function dismiss(returnFocus = false) {
        document.removeEventListener("pointerdown", outside, true);
        document.removeEventListener("focusin", outside);
        window.removeEventListener("scroll", scroll, true);
        window.removeEventListener("resize", refresh);
        popup.remove();
        trigger.setAttribute("aria-expanded", "false");
        trigger.removeAttribute("aria-controls");
        active = null;
        if (returnFocus && origin.isConnected) origin.focus({preventScroll: true});
      }
      function outside(event) {
        if (!popup.contains(event.target) && !root.contains(event.target)) dismiss();
      }
      function scroll(event) {
        if (!(event.target instanceof Node) || !popup.contains(event.target)) refresh();
      }
      function refresh() {
        const rect = root.getBoundingClientRect();
        const clip = root.closest(".table-scroll")?.getBoundingClientRect();
        if (!root.isConnected || rect.bottom <= 0 || rect.top >= window.innerHeight
          || rect.right <= Math.max(0, clip?.left ?? 0) || rect.left >= Math.min(window.innerWidth, clip?.right ?? window.innerWidth)) {
          dismiss();
          return;
        }
        place(popup, root);
      }

      cancel.addEventListener("click", () => dismiss(true));
      apply.addEventListener("click", () => {
        const next = nextSelection();
        let replacement;
        try {
          replacement = onChange(next);
        } catch (failure) {
          error.textContent = failure.message;
          error.hidden = false;
          refresh();
          return;
        }
        saved = next;
        setCaption();
        if (active?.root === root) dismiss(!replacement?.isConnected);
        if (replacement?.isConnected) replacement.focus({preventScroll: true});
      });
      popup.addEventListener("keydown", event => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss(true);
        } else if (["ArrowDown", "ArrowUp"].includes(event.key) && boxes.includes(event.target)) {
          event.preventDefault();
          const offset = event.key === "ArrowDown" ? 1 : -1;
          boxes[(boxes.indexOf(event.target) + offset + boxes.length) % boxes.length].focus();
        }
      });
      actions.append(cancel, apply);
      popup.append(list, error, actions);
      document.body.append(popup);
      active = {root, close: dismiss};
      trigger.setAttribute("aria-expanded", "true");
      trigger.setAttribute("aria-controls", id);
      refresh();
      if (active?.root !== root) return;
      document.addEventListener("pointerdown", outside, true);
      document.addEventListener("focusin", outside);
      window.addEventListener("scroll", scroll, true);
      window.addEventListener("resize", refresh);
      const focus = boxes.find(box => preferNew ? !box.checked : box.checked) || boxes[0];
      focus?.focus({preventScroll: true});
      focus?.scrollIntoView({block: "nearest", inline: "nearest"});
    }

    trigger.addEventListener("click", () => open(trigger, false));
    trigger.addEventListener("keydown", event => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      open(trigger, false);
    });
    add.addEventListener("click", () => open(add, true));
    return root;
  }

  window.addEventListener("ceasefire:languagechange", () => {
    close();
    for (const picker of document.querySelectorAll(".pricing-group-picker")) captions.get(picker)?.();
  });
  window.CeasefirePricingGroups = {create, close};
})();
