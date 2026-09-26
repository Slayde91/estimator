"""Conservative ownership of technical-library content, separate from label aliases.

The input is the canonical-labelled view; the importer retains the untouched source
fields independently.  Only explicit labels, complete phrases and exact duplicates
are used here.  In particular, dimensions are never treated as equivalent merely
because their numbers happen to match.
"""

from copy import deepcopy
import re
import unicodedata


CONFIGURATION = "Service Size / Configuration"
INSTALLATION = "Installation Details"
_SPACE = re.compile(r"\s+")
_STEP = re.compile(r"^\s*\d+[.)]\s+")
_MEASUREMENT = re.compile(
    r"(?:\b(?:DN|NB)\s*\d|\d\s*(?:mm|cm|inch|\"|×|x)\b|"
    r"\b(?:up to|bundle of|configuration|config\.|consisting of|standard D[12]|"
    r"Appendix D[12]|one of|two of|three of|four of)\b)", re.I
)
_SERVICE_NOUN = re.compile(
    r"\b(?:pipes?|conduits?|cables?|pair\s*coils?|aircon|air-con|cable tray|"
    r"ducts?|threaded rods?|purlins?|beams?|services?)\b", re.I
)
_WRAP = re.compile(r"\b(?:wrap(?:ped|ping)?|TWrap|Penowrap|FIREFLYPenowrap)\b", re.I)
_SOURCE_OPTIONS = re.compile(r"\bsource option\b|\boption [A-Z0-9]+\b", re.I)
_STEP_REFERENCE = {
    "Service Wrap": "Apply the Service Wrap requirements.",
    "Local Protection": "Apply the Local Protection requirements.",
    "Seal Depth / Fillet Size": "Use the Seal Depth / Fillet Size requirements.",
    "Joint Treatment": "Use the Joint Treatment requirements.",
    CONFIGURATION: "Use the specified Service Size / Configuration.",
    "Service Spacing": "Position the services to the Service Spacing requirements.",
}


def _key(value):
    """Ignore presentation only: do not erase qualifiers, quantities or negation."""
    value = unicodedata.normalize("NFKC", str(value or ""))
    value = value.replace("\u00d7", "x").replace("\u2013", "-").replace("\u2014", "-")
    value = re.sub(r"(?<=\d)\s+(?=(?:mm|cm|kg|m2|m3)\b)", "", value, flags=re.I)
    return _SPACE.sub(" ", _STEP.sub("", value)).strip().rstrip(".;").casefold()


def _paragraphs(value):
    return [part.strip() for part in re.split(r"\n\s*\n", str(value or "")) if part.strip()]


def _units(value):
    """Keep numbered steps whole; splitting a step would detach its conditions."""
    parts = re.split(r"(?m)(?=^\s*\d+[.)]\s+)", str(value or ""))
    if len(parts) > 1:
        return [part.strip() for part in parts if part.strip()]
    return _paragraphs(value)


def _has_payload(field):
    return bool(field.get("images") or field.get("tables") or field.get("table"))


def _sources(field):
    return list(field.get("source_labels") or [field.get("label", "")])


def _append(fields, label, value, origin):
    value = str(value or "").strip()
    if not value:
        return
    same = [field for field in fields if field.get("label") == label and not _has_payload(field)]
    normalized = _key(value)
    for field in same:
        if any(_key(part) == normalized for part in _paragraphs(field.get("value"))):
            field["source_labels"] = list(dict.fromkeys(_sources(field) + _sources(origin)))
            return
    fields.append({"label": label, "value": value, "source_labels": _sources(origin)})


def _service_category(value):
    """Return a noun category only when the source itself states it explicitly."""
    compact = _SPACE.sub(" ", value).strip()
    patterns = (
        r"\b(nitrile rubber (?:lagged|insulated) copper pipes?)\b",
        r"\b(XLPE lagged pair coil)\b",
        r"\b(insulated twin air-con copper pipe)\b",
        r"\b(mixed cable and lagged copper pipe bundle)\b",
        r"\b(aircon bundle)\b",
        r"\b(copper pipes?|steel pipes?|HDPE pipes?|CPVC fire sprinkler pipes?|"
        r"PEX-AL gas pipes?|PEX pipes?|uPVC pipes?|PVC pipes?|PVC conduits?)\b",
        r"\b(threaded rods?|purlins?|steel beams?)\b",
        r"\b(coaxial cables?|power cables?|communication cables?|data cables?|"
        r"electrical cables?|fire alarm cables?|fibre optic cables?)\b",
    )
    for pattern in patterns:
        match = re.search(pattern, compact, re.I)
        if match:
            return match.group(1)
    return ""


def _move_service_fields(fields):
    additions = []
    has_service_category = any(
        field.get("label") == "Service" and any(
            not (_MEASUREMENT.search(part) and _SERVICE_NOUN.search(part))
            for part in _paragraphs(field.get("value"))
        ) for field in fields
    )
    for field in fields:
        if field.get("label") != "Service" or _has_payload(field):
            continue
        retained = []
        for paragraph in _paragraphs(field.get("value")):
            # Short product/service categories stay Service.  Full assessed
            # configurations, including their equivalent-area exceptions, move
            # as a whole rather than reducing them to a loose dimension.
            if not (_MEASUREMENT.search(paragraph) and _SERVICE_NOUN.search(paragraph)):
                retained.append(paragraph)
                continue
            main, *notes = re.split(r"\bNOTES?\s*:\s*", paragraph, maxsplit=1, flags=re.I)
            main = main.strip()
            if main:
                _append(additions, CONFIGURATION, main, field)
                category = _service_category(main)
                if not has_service_category and category and _key(category) not in {_key(v) for v in retained}:
                    retained.append(category)
            if notes:
                # Bullets are complete conditions; keep each condition attached
                # to its action instead of extracting a dimension from it.
                note_parts = re.split(r"(?:^|\n)\s*[\u2022\ufffd]\s*", notes[0])
                for note in note_parts:
                    note = note.strip()
                    if not note:
                        continue
                    if _WRAP.search(note):
                        destination = "Service Wrap"
                    elif re.search(r"\b(?:fillet|sealant|mastic)\b", note, re.I):
                        destination = "Local Protection"
                    else:
                        destination = CONFIGURATION
                    _append(additions, destination, note, field)
        field["value"] = "\n\n".join(retained)
    fields.extend(additions)


def _move_service_configuration_tables(fields):
    """Move a size-indexed table whole, preserving every coupled source column."""
    additions = []
    moved = False
    for field in fields:
        if field.get("label") != "Service":
            continue
        tables = ([field["table"]] if field.get("table") else []) + field.get("tables", [])
        matching = [table for table in tables if any(
            re.search(r"^Service\s*\([^)]*(?:size|dimension)[^)]*\)$", column, re.I)
            for column in table.get("columns", [])
        )]
        if not matching:
            continue
        field.pop("table", None)
        field.pop("tables", None)
        remaining = [table for table in tables if table not in matching]
        if len(remaining) == 1:
            field["table"] = remaining[0]
        elif remaining:
            field["tables"] = remaining
        additions.append({"label": CONFIGURATION, "value": "", "tables": matching,
                          "source_labels": _sources(field)})
        moved = True
    fields.extend(additions)
    if moved:
        for field in fields:
            if field.get("label") in {"Service Wrap", "Protection", INSTALLATION}:
                field["value"] = str(field.get("value") or "").replace(
                    "Size-specific lengths and their FRLs are preserved in the Service table.",
                    "Size-specific lengths and their FRLs are preserved in the Service Size / Configuration table.",
                )


def _classify_protection(fields):
    for field in fields:
        if field.get("label") != "Protection" or _has_payload(field):
            continue
        value = str(field.get("value") or "")
        mixed_construction = re.search(
            r"(?m)^\s*\d+[.)]\s*(?:Cut\s+strips\b|Form\s+[^\n.]*\bcollar\b|"
            r"(?:Install|Fit)\s+(?![^\n.]*\b(?:wrap|Penowrap)\b)[^\n.]*\b(?:board|batt)\b)",
            value, re.I,
        )
        if mixed_construction:
            # Mixed board/collar/wrap construction is a procedure, not a single
            # wrap specification. Preserve its ordering.
            field["label"] = INSTALLATION
        elif _WRAP.search(value):
            field["label"] = "Service Wrap"
        elif re.search(r"(?m)^\s*\d+[.)]\s+", value):
            field["label"] = INSTALLATION
        elif re.search(r"\b(?:fillet|mastic|sealant)\b", value, re.I):
            field["label"] = "Local Protection"
        # 'None' without a more specific scope remains Protection. It does not
        # prove that no wrap or local seal is required.


def _parse_explicit_source_fields(fields):
    additions = []
    for field in fields:
        labels = " ".join(_sources(field)).casefold()
        value = str(field.get("value") or "")
        if "service / core hole / annular gap" in labels:
            # This source structure has explicitly named values; do not infer
            # the maximum opening from an exact core-hole diameter.
            pattern = re.compile(
                r"\b(Service/s|Core Hole|Annular Gap|FRL|Fire Barrier):\s*", re.I
            )
            matches = list(pattern.finditer(value))
            if matches and not value[:matches[0].start()].strip():
                remaining = []
                for index, match in enumerate(matches):
                    end = matches[index + 1].start() if index + 1 < len(matches) else len(value)
                    text = value[match.end():end].strip().rstrip("; ")
                    key = match.group(1).casefold()
                    destination = {
                        "service/s": CONFIGURATION,
                        "core hole": "Core Hole Diameter",
                        "annular gap": "Annular Gap",
                        "frl": "FRL",
                        "fire barrier": "Barrier Construction",
                    }[key]
                    if key == "frl":
                        rating = re.match(r"([\d-]+/[\d-]+/[\d-]+)[.;]?\s*(.*)", text, re.S)
                        if not rating:
                            remaining.append(match.group(0) + text)
                            continue
                        text = rating.group(1)
                        if rating.group(2).strip():
                            remaining.append(rating.group(2).strip())
                    _append(additions, destination, text.rstrip("."), field)
                field["value"] = "\n\n".join(remaining)
                field["label"] = INSTALLATION
        elif "substrate / opening" in labels:
            match = re.fullmatch(
                r"\s*(.+?)\.\s*Hole dimensions to be (\d+(?:\.\d+)?\s*mm) diameter\.\s*",
                value, re.I | re.S,
            )
            if match:
                _append(additions, "Barrier Construction", match.group(1), field)
                _append(additions, "Core Hole Diameter", match.group(2), field)
                field["value"] = ""
        elif field.get("label") == "Maximum Opening Size":
            # Several imported selector values describe gap only, rather than
            # the overall opening. Keep their actual meaning in the label.
            if re.match(r"^\s*Annular Gap\b", value, re.I) and not re.search(
                r"\b(?:opening|core hole)\b", value, re.I
            ):
                field["label"] = "Annular Gap"
                field["value"] = re.sub(r"^\s*Annular Gap\s*:?\s*", "", value, flags=re.I)
    fields.extend(additions)


def _exact_owner_for(unit, owners):
    normalized = _key(unit)
    # Short bare values like '300 mm' or 'None' are not safe cross-field matches.
    if len(normalized) < 25:
        return None
    for label, candidates in owners.items():
        for candidate in candidates:
            if normalized == _key(candidate):
                return label
    return None


def _dedupe_owned_instructions(fields):
    owners = {}
    for field in fields:
        label = field.get("label")
        if label in _STEP_REFERENCE:
            owners.setdefault(label, []).extend(_units(field.get("value")))
    for field in fields:
        if field.get("label") != INSTALLATION or _has_payload(field):
            continue
        remaining = []
        for unit in _units(field.get("value")):
            owner = _exact_owner_for(unit, owners)
            if owner:
                prefix = re.match(r"^(\s*\d+[.)]\s+)", unit)
                # Retain the position of an installation step without repeating
                # its technical specification from the owning field.
                if prefix:
                    remaining.append(prefix.group(1) + _STEP_REFERENCE[owner])
            else:
                remaining.append(unit)
        field["value"] = "\n".join(remaining)


def _configuration_phrases(fields):
    values = [str(field.get("value") or "") for field in fields
              if field.get("label") == CONFIGURATION and not _has_payload(field)]
    phrases = []
    # Only explicit noun phrases, not free dimensions. These forms are used by
    # the supplied selector/source paragraphs. More complex bundles stay whole.
    pattern = re.compile(
        r"\b(?:\d+(?:\.\d+)?\s*mm|DN\s*\d+)\s+"
        r"(?:(?:u?PVC|HDPE|CPVC|PEX(?:-AL-PEX)?|copper|steel)\s+)?"
        r"(?:pipes?|conduits?)\b", re.I,
    )
    for value in values:
        for match in pattern.finditer(value):
            phrase = match.group(0)
            if _key(phrase) not in {_key(v) for v in phrases}:
                phrases.append(phrase)
    return phrases


def _remove_repeated_configuration_phrases(fields):
    phrases = _configuration_phrases(fields)
    # A generic reference is only unambiguous when there is one named service
    # configuration. With multiple services, their dimensions identify which
    # action applies to which service and must remain attached to that action.
    if len(phrases) != 1:
        return
    for field in fields:
        if field.get("label") != INSTALLATION or _has_payload(field):
            continue
        value = str(field.get("value") or "")
        # Conditional service→wrap/collar mappings are relationships. Do not
        # replace their conditions with a generic service reference.
        if _SOURCE_OPTIONS.search(value):
            continue
        units = _units(value)
        changed = []
        for unit in units:
            if re.search(r"\b(?:for|if|where|when|between|up to|over|greater than)\b", unit, re.I):
                changed.append(unit)
                continue
            for phrase in phrases:
                parts = re.split(r"\s+", phrase)
                pattern = r"\b" + r"\s*".join(re.escape(part) for part in parts) + r"\b"
                unit = re.sub(pattern, "specified service", unit, flags=re.I)
            changed.append(unit)
        field["value"] = "\n".join(changed)


def _dedupe_same_owner(fields):
    """Collapse equal complete blocks, never alternative fragments or numbers."""
    seen = {}
    configurations = [part for field in fields if field.get("label") == CONFIGURATION
                      and not _has_payload(field) for part in _paragraphs(field.get("value"))]
    for field in fields:
        label = field.get("label")
        if _has_payload(field) or label in {"Source Options", "Source Issues", "Diagrams & Figures"}:
            continue
        retained = []
        for part in _paragraphs(field.get("value")):
            normalized = _key(part)
            if not normalized:
                continue
            if label == CONFIGURATION and _MEASUREMENT.search(part) and _SERVICE_NOUN.search(part):
                # A bare named configuration adds nothing to the same named
                # configuration with an explicit qualification. Do not compare
                # unrelated numeric fragments or conditional option lists.
                redundant = any(
                    _key(other).startswith(normalized + " ")
                    and re.match(r"^(?:without|with)\b", _key(other)[len(normalized):].strip())
                    and not _SOURCE_OPTIONS.search(other)
                    for other in configurations if _key(other) != normalized
                )
                if redundant:
                    continue
            if normalized in seen.setdefault(label, set()):
                continue
            seen[label].add(normalized)
            retained.append(part)
        field["value"] = "\n\n".join(retained)


def _dedupe_control_joint_width(fields):
    # A control joint is the opening itself, not a pipe/cable size. Only remove
    # the exact duplicate; a different width or qualified range remains visible.
    if not any(field.get("label") == "Service" and _key(field.get("value")) == "control joint"
               for field in fields):
        return
    widths = {_key(field.get("value")) for field in fields
              if field.get("label") == "Maximum Opening Size" and not _has_payload(field)}
    widths.discard("")
    for field in fields:
        if field.get("label") == CONFIGURATION and not _has_payload(field) and _key(field.get("value")) in widths:
            field["value"] = ""


def normalize_content(fields):
    """Return canonical view fields with facts in their explicit owning fields.

    No source dictionaries are changed in place. Structured variant tables and
    all diagram assets are carried through without flattening.
    """
    result = deepcopy(list(fields))
    _classify_protection(result)
    _move_service_configuration_tables(result)
    _move_service_fields(result)
    _parse_explicit_source_fields(result)
    _dedupe_owned_instructions(result)
    _remove_repeated_configuration_phrases(result)
    _dedupe_same_owner(result)
    _dedupe_control_joint_width(result)
    return [field for field in result if str(field.get("value") or "").strip() or _has_payload(field)]
