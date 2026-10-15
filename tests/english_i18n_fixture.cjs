"use strict";
// Deterministic English presentation adapter for focused VM fixtures. These
// fixtures test source geometry/async guards with small DOM doubles; the real
// language runtime and language switching are tested separately in a browser.
module.exports = function englishI18n() {
  const owned = Symbol("owned UI term"), bindings = new WeakMap();
  const format = (source, args = []) => String(source).replace(/\{(\d+)\}/g, (match, index) => {
    if (index >= args.length) return match;
    const value = typeof args[index] === "function" ? args[index]() : args[index];
    return value?.[owned] ? format(value.source, value.args) : String(value ?? "");
  });
  const text = (element, source, args = []) => { element.textContent = format(source, args); bindings.set(element, element.textContent); return element; };
  return Object.freeze({ text, nodeText: text,
    attr(element, attribute, source, args = []) { const value = format(source, args); element.setAttribute(attribute, value); if (["title", "placeholder", "alt"].includes(attribute)) element[attribute] = value; return element; },
    source(element, attribute) { return attribute ? element.getAttribute(attribute) : bindings.get(element) === element.textContent ? bindings.get(element) : element.textContent; },
    translate: format, term: (source, args = []) => ({[owned]: true, source, args}), language: "en" });
};
