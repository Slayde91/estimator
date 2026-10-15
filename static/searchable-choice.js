"use strict";

// A bounded, keyboard-accessible choice list. The caller still owns validation
// and committing the exact source value; search text never becomes a choice.
window.CeasefireSearchableChoice = function (input, values) {
  // Bind application-owned copy only; node() remains safe for user and source text.
  const uiText = (element, source, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.text(element, source, args);
    element.textContent = String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(typeof args[index] === "function" ? args[index]() : args[index])); return element;
  };
  const uiAttr = (element, name, source, args = []) => {
    if (window.CeasefireI18n) return window.CeasefireI18n.attr(element, name, source, args);
    const value = String(source).replace(/\{(\d+)\}/g, (match, index) => args[index] === undefined ? match : String(typeof args[index] === "function" ? args[index]() : args[index]));
    element.setAttribute(name, value); if (["title", "placeholder"].includes(name)) element[name] = value; return element;
  };

  const wrapper = document.createElement("div"), toggle = document.createElement("button"), popup = document.createElement("div"), list = document.createElement("div"), status = document.createElement("div");
  wrapper.className = "searchable-choice"; popup.className = "searchable-choice-popup"; list.className = "searchable-choice-list"; status.className = "helper";
  list.id = `choice-${window.crypto.randomUUID()}`; list.setAttribute("role", "listbox"); uiAttr(list, "aria-label", "{0} choices", [() => input.getAttribute("aria-label")]);
  input.setAttribute("role", "combobox"); input.setAttribute("aria-controls", list.id); input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-expanded", "false");
  toggle.type = "button"; toggle.tabIndex = -1; toggle.className = "searchable-choice-toggle"; toggle.textContent = "⌄"; uiAttr(toggle, "aria-label", "Show {0} choices", [() => input.getAttribute("aria-label")]);
  status.setAttribute("role", "status"); popup.hidden = true; popup.append(list, status); wrapper.append(input, toggle, popup);
  let matches = [], active = -1, committed = input.value;
  const normalize = text => String(text).toLocaleLowerCase("en-AU").replace(/×/g, "x").replace(/\s/g, "");
  const moveOutside = event => { if (!popup.contains(event.target)) close(); };
  const close = () => { popup.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; window.removeEventListener("scroll", moveOutside, true); window.removeEventListener("resize", close); };
  const commit = value => { input.value = String(value); input.dispatchEvent(new Event("change", {bubbles:true})); committed = input.value; close(); };
  function highlight(index) {
    active = index;
    [...list.children].forEach((option, i) => option.setAttribute("aria-selected", String(i === active)));
    if (active >= 0) { input.setAttribute("aria-activedescendant", list.children[active].id); list.children[active].scrollIntoView({block:"nearest"}); }
  }
  function open(query = input.value) {
    const found = values.filter(value => normalize(value).includes(normalize(query))); matches = found.slice(0, 80); active = -1;
    list.replaceChildren(...matches.map((value, index) => {
      const option = document.createElement("div"); option.id = `${list.id}-${index}`; option.setAttribute("role", "option"); option.setAttribute("aria-selected", "false"); option.textContent = String(value);
      option.addEventListener("pointerdown", event => { event.preventDefault(); commit(value); input.focus(); }); return option;
    }));
    if (!found.length) uiText(status, "No matching sections. Choose a listed value.");
    else if (found.length > matches.length) uiText(status, "{0} matches. Type more to narrow the list.", [found.length]);
    else uiText(status, "{0} choices", [found.length]);
    const bounds = input.getBoundingClientRect();
    popup.style.position = "fixed"; popup.style.left = `${bounds.left}px`; popup.style.top = `${bounds.bottom}px`; popup.style.minWidth = `${bounds.width}px`;
    popup.hidden = false; input.setAttribute("aria-expanded", "true"); input.removeAttribute("aria-activedescendant");
    window.addEventListener("scroll", moveOutside, true); window.addEventListener("resize", close);
  }
  input.addEventListener("focus", () => { committed = input.value; });
  input.addEventListener("input", () => open());
  input.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation(); if (popup.hidden) open("");
      if (matches.length) highlight(Math.max(0, Math.min(matches.length - 1, active + (event.key === "ArrowDown" ? 1 : -1))));
    } else if (event.key === "Enter" && !popup.hidden) {
      event.preventDefault(); event.stopPropagation(); commit(active >= 0 ? matches[active] : input.value);
    } else if (event.key === "Escape" && !popup.hidden) {
      event.preventDefault(); event.stopPropagation(); input.value = committed; close();
    }
  });
  input.addEventListener("blur", () => { if (input.value !== committed) commit(input.value); else close(); });
  toggle.addEventListener("pointerdown", event => event.preventDefault());
  toggle.addEventListener("click", () => { input.focus(); if (popup.hidden) open(""); else close(); });
  return wrapper;
};
