# Application languages

Open **Settings → Language** and use the globe button. Choose English, Mandarin Chinese (Simplified Chinese), Hindi, Spanish, Modern Standard Arabic, Thai, Korean, Tagalog or Vietnamese. Each choice uses its native language name. The interface changes immediately, including controls and messages already on screen. Selecting a language does not reload the project or clear drafts.

The globe menu works with a mouse, touch or keyboard. Enter or Space opens it; Arrow Up/Down moves through the options, Home/End moves to the first/last option, and Enter/Space selects. Escape dismisses the menu and returns focus to the globe. The selected language is announced as checked. A native select remains available if menu setup cannot run.

The preference belongs to the current browser profile and application address. It is retained when reopening that address. Another browser or the installed desktop edition has its own preference. English is the default. If browser storage is unavailable, the selection still works for the current session.

Navigation, settings, application forms, document menus, Help, drawing tools, register controls and application messages use bundled translations. Arabic uses right-to-left interface layout. Drawings, PDF pages, source diagrams and worksheet grids retain their original orientation. Fonts fall back to the operating system's Chinese, Hindi, Arabic, Thai and Korean fonts; translation does not require an internet service or API key.

Project names, client text, filenames, product names and source evidence retain their original wording. Fixed calculator table headings and interface labels can be translated on screen; the underlying workbook text, formulas and values remain canonical. Numeric inputs, units, currency, calculation precision and saved project formats retain their existing conventions. PDF and Excel exports retain their original English presentation. Native file dialogs follow the operating system's language. Unrecognized diagnostic details fall back to their original text.

Access & Travel labels and application-owned route messages also switch languages. Addresses and Google-provided route summaries remain literal source text. A language change does not request another route or save locations with the project.

## Maintaining translations

`static/locales/*.json` contains application-owned English source messages and the original five translations, ordered as `zh-Hans`, `hi`, `es`, `ar`, `th`. Matching files under `static/locales/additions/` contain complete `ko`, `tl`, `vi` translations of the same keys. This keeps the original translations unchanged. The generated runtime joins the eight translations in that order into `static/language-catalog.js`; rebuild it with `python scripts/build_language_catalog.py`. CI runs `--check` to reject duplicate or missing source keys, missing/empty translations, changed placeholder multiplicity or a stale generated bundle. Missing translations are never filled with copied English to pass completeness checks. Product names, acronyms, units and symbolic expressions intentionally keep their canonical text.

Bind explicit application-owned copy using `CeasefireI18n.text(element, source, args)` or `attr(element, attribute, source, args)`. Use numbered placeholders such as `{0}` for variable data. Use `nodeText` on a new empty element when icons or other children will be appended. Use `term(source, args)` only for nested application-owned terms. Existing bindings update on `ceasefire:languagechange` without rebuilding forms.

Keep arbitrary user, product, filename, library metadata and source-document text outside translation bindings, even when it happens to equal an English UI term. Never translate `option.value`, worksheet addresses, enum values sent to the server or calculation state. Logic that must inspect a bound label uses `CeasefireI18n.source(element)` to read canonical copy. Function-valued label arguments are presentation-only and must never be used for logic or persistence.

Fixed workbook-backed interface labels are explicitly listed in `calculatorLabelSources` in `static/calculators.js`, by calculator, sheet, address and expected original text. Only matching non-editable label cells use those bindings. Formula results, product names and editable values are excluded. Review this ownership map when workbook presentation metadata changes; an unfamiliar label must fall back to its original text rather than translate arbitrary cell content.

Static application-owned labels use `data-i18n`, `data-i18n-title`, `data-i18n-aria-label`, `data-i18n-placeholder` or `data-i18n-alt`. `data-i18n-rich` is limited to static explanatory prose; it must not surround interactive controls or elements referenced by other scripts.

Language regression checks cover all nine settings, globe-menu keyboard operation, persistence, immediate updates, unchanged canonical inputs/totals, English fallback for unrecognized diagnostics, source text collisions and Arabic drawing orientation. They run against disposable databases and source documents.
