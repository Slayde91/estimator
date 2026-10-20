"use strict";
// The production runtime has independent ownership/lifecycle tests. This adapter
// lets focused component fixtures exercise the real local translation catalog.
const fs = require("node:fs"), path = require("node:path");
module.exports = (locale = "zh-Hans") => {
  const english = require("../english_i18n_fixture.cjs")(), folder = path.join(__dirname, "../../static/locales");
  const messages = Object.assign({}, ...fs.readdirSync(folder).filter(name => name.endsWith(".json")).sort().map(name => {
    const base = JSON.parse(fs.readFileSync(path.join(folder, name), "utf8")), additions = JSON.parse(fs.readFileSync(path.join(folder, 'additions', name), "utf8"));
    return Object.fromEntries(Object.entries(base).map(([source, translations]) => [source, translations.concat(additions[source])]));
  }));
  const index = ["zh-Hans", "hi", "es", "ar", "th", "ko", "tl", "vi"].indexOf(locale);
  const translated = source => index < 0 ? source : messages[source]?.[index] || source;
  const translate = (source, args = []) => english.translate(translated(source), args);
  return { ...english, language: locale, translate, term: (source, args = []) => () => translate(source, args),
    text: (element, source, args) => english.text(element, translated(source), args),
    nodeText: (element, source, args) => english.nodeText(element, translated(source), args),
    attr: (element, name, source, args) => english.attr(element, name, translated(source), args) };
};
