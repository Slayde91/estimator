# Application languages

Open **Settings → Language → Application language**. Choose English, Mandarin Chinese (Simplified Chinese), Hindi, Spanish, Modern Standard Arabic or Thai. The interface changes immediately, including controls and messages already on screen. Selecting a language does not reload the project or clear drafts.

The preference belongs to the current browser profile and application address. It is retained when reopening that address. Another browser or the installed desktop edition has its own preference. English is the default. If browser storage is unavailable, the selection still works for the current session.

Navigation, settings, application forms, document menus, Help, drawing tools, register controls and application messages use bundled translations. Arabic uses right-to-left interface layout. Drawings, PDF pages, source diagrams and worksheet grids retain their original orientation. Fonts fall back to the operating system's Chinese, Hindi, Arabic and Thai fonts; translation does not require an internet service or API key.

Project names, client text, filenames, product names and source evidence retain their original wording. Fixed calculator table headings and interface labels can be translated on screen; the underlying workbook text, formulas and values remain canonical. Numeric inputs, units, currency, calculation precision and saved project formats retain their existing conventions. PDF and Excel exports retain their original English presentation. Native file dialogs follow the operating system's language. Unrecognized diagnostic details fall back to their original text.

## Maintaining translations

`static/locales/*.json` contains application-owned English source messages and five translations, ordered as `zh-Hans`, `hi`, `es`, `ar`, `th`. The runtime uses `static/language-catalog.js`; rebuild it with `python scripts/build_language_catalog.py`. CI runs `--check` to detect missing languages, changed placeholders or a stale generated bundle.

Bind explicit application-owned copy using `CeasefireI18n.text(element, source, args)` or `attr(element, attribute, source, args)`. Use numbered placeholders such as `{0}` for variable data. Use `nodeText` on a new empty element when icons or other children will be appended. Use `term(source, args)` only for nested application-owned terms. Existing bindings update on `ceasefire:languagechange` without rebuilding forms.

Keep arbitrary user, product, filename, library metadata and source-document text outside translation bindings, even when it happens to equal an English UI term. Never translate `option.value`, worksheet addresses, enum values sent to the server or calculation state. Logic that must inspect a bound label uses `CeasefireI18n.source(element)` to read canonical copy. Function-valued label arguments are presentation-only and must never be used for logic or persistence.

Fixed workbook-backed interface labels are explicitly listed in `calculatorLabelSources` in `static/calculators.js`, by calculator, sheet, address and expected original text. Only matching non-editable label cells use those bindings. Formula results, product names and editable values are excluded. Review this ownership map when workbook presentation metadata changes; an unfamiliar label must fall back to its original text rather than translate arbitrary cell content.

Static application-owned labels use `data-i18n`, `data-i18n-title`, `data-i18n-aria-label`, `data-i18n-placeholder` or `data-i18n-alt`. `data-i18n-rich` is limited to static explanatory prose; it must not surround interactive controls or elements referenced by other scripts.

Language regression checks cover all six settings, persistence, immediate updates, unchanged canonical inputs/totals, English fallback, source text collisions and Arabic drawing orientation. They run against disposable databases and source documents.
