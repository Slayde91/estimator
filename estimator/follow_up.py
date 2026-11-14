"""Portable follow-up actions and compatibility with the original reminder pair."""

from datetime import date, datetime, timezone
from uuid import UUID, NAMESPACE_URL, uuid5

from .catalog import ValidationError


FOLLOW_UP_LIMITS = {"next_action": 500, "follow_up_date": 10}
LEGACY_PROJECT_ID = "00000000-0000-4000-8000-000000000001"
ACTION_KEYS = {"id", "next_action", "follow_up_date", "status"}


def validate_follow_up_date(value):
    if value:
        try:
            if date.fromisoformat(value).isoformat() != value:
                raise ValueError
        except (ValueError, TypeError):
            raise ValidationError("Enter a valid follow-up date.") from None


def _fields(values):
    result = {}
    for key, maximum in FOLLOW_UP_LIMITS.items():
        value = values.get(key, "")
        if not isinstance(value, str) or len(value) > maximum or any(
            0xD800 <= ord(c) <= 0xDFFF or ord(c) < 32 and c not in "\n\r\t" for c in value
        ):
            raise ValidationError(f"Check {key.replace('_', ' ')} (maximum {maximum} characters).")
        result[key] = value.strip()
    validate_follow_up_date(result["follow_up_date"])
    return result


def legacy_actions(values, owner="project"):
    fields = _fields(values)
    if not any(fields.values()):
        return []
    identity = LEGACY_PROJECT_ID if owner == "project" else str(uuid5(NAMESPACE_URL, "classifire:lead-follow-up:" + owner))
    return [{"id": identity, **fields, "status": ""}]


def validate_actions(value):
    if not isinstance(value, list):
        raise ValidationError("Include the list of follow-up actions.")
    rows, seen = [], set()
    for raw in value:
        if not isinstance(raw, dict) or set(raw) != ACTION_KEYS:
            raise ValidationError("Include each follow-up action's ID, next action, date and status.")
        identity = raw["id"]
        try:
            if not isinstance(identity, str) or str(UUID(identity)) != identity or identity in seen:
                raise ValueError
        except ValueError:
            raise ValidationError("Each follow-up action must have a unique valid ID.") from None
        seen.add(identity)
        fields = _fields(raw)
        status = raw["status"]
        if status not in ("", "Completed", "Canceled"):
            raise ValidationError("Choose a valid follow-up action status.")
        if not any(fields.values()):
            if status:
                raise ValidationError("Enter a next action or follow-up date before recording a decision.")
            continue
        rows.append({"id": identity, **fields, "status": status})
    return rows


def _first_open(actions):
    # min is stable, so equally urgent actions retain their saved ordering.
    return min((row for row in actions if not row["status"]),
               key=lambda row: (not row["follow_up_date"], row["follow_up_date"]), default=None)


def summary_fields(actions):
    row = _first_open(actions) or {}
    return {key: row.get(key, "") for key in FOLLOW_UP_LIMITS}


def project_response(payload):
    """Expose the active reminder to single-action clients opening or saving a project."""
    if "project" in payload:
        return {**payload, "project":project_response(payload["project"])}
    if "project_follow_up" in payload:
        follow_up = payload["project_follow_up"]
        return {**payload, "project_follow_up":{**follow_up, **summary_fields(follow_up["actions"])}}
    return payload


def reconcile_actions(previous, values, owner="project", *, allow_corrections=False):
    """Apply a full modern edit or a legacy edit to the one projected open row."""
    if not isinstance(values, dict) or set(values) - {"actions", *FOLLOW_UP_LIMITS}:
        raise ValidationError("Follow-up contains unsupported fields.")
    if "actions" in values:
        rows = validate_actions(values["actions"])
        by_id = {row["id"]: row for row in rows}
        for row in previous:
            if row["id"] not in by_id:
                raise ValidationError("Keep existing follow-up actions. Complete or cancel an action to close it.")
            if row["status"] and row != by_id[row["id"]] and not allow_corrections:
                raise ValidationError("Completed and canceled follow-up actions cannot be changed.")
        return rows
    if not values:
        return previous
    active = _first_open(previous)
    fields = _fields({**summary_fields(previous), **values})
    if active is not None:
        return [({**row, **fields} if row["id"] == active["id"] else row)
                for row in previous if row["id"] != active["id"] or any(fields.values())]
    if not any(fields.values()):
        return previous
    fresh = legacy_actions(fields, owner)[0]
    ids = {row["id"] for row in previous}
    # Old callers can create a second reminder after the original reached a decision.
    while fresh["id"] in ids:
        fresh["id"] = str(uuid5(UUID(fresh["id"]), "next follow-up"))
    return validate_actions([*previous, fresh])


def action_changes(previous, latest):
    """Yield new decisions and explicit amendments to a previous decision."""
    prior = {row["id"]: row for row in previous}
    for row in latest:
        old = prior.get(row["id"])
        if old != row and (row["status"] or old and old["status"]):
            yield old, row


def history_event(event):
    previous = event.get("previous")
    def description(row):
        return " · ".join(filter(None, [row["next_action"], row["follow_up_date"], row["status"] or "Pending"]))
    subject = (description(previous) + " → " + description(event) if previous else
               " · ".join(filter(None, [event["next_action"], event["follow_up_date"]])))
    label = "Follow-up corrected" if previous else "Follow-up " + event["status"].lower()
    return {"label":label, "at":event["at"], "subject":subject, **({"actor":event["actor"]} if event.get("actor") else {})}


def project_follow_up(values):
    """Read or export the portable form, validating its historical receipts."""
    if not isinstance(values, dict):
        raise ValidationError("Project follow-up contains unsupported fields.")
    if set(values) <= FOLLOW_UP_LIMITS.keys():
        return {"actions": legacy_actions(values)}
    if "actions" not in values or set(values) - {"actions", "history", *FOLLOW_UP_LIMITS}:
        raise ValidationError("Project follow-up contains unsupported fields.")
    # A client can echo the entire native response. Only the array is authoritative.
    if FOLLOW_UP_LIMITS.keys() & values.keys():
        _fields(values)
    actions = validate_actions(values["actions"])
    result = {"actions": actions}
    history = values.get("history", [])
    if not isinstance(history, list):
        raise ValidationError("Invalid project follow-up history.")
    rows = {row["id"]: row for row in actions}
    last, events = {}, []
    for event in history:
        if (not isinstance(event, dict) or not (ACTION_KEYS | {"at"}) <= event.keys()
                or event.keys() - ACTION_KEYS - {"at", "previous", "actor"}):
            raise ValidationError("Invalid project follow-up history.")
        identity, stamp = event["id"], event["at"]
        row = {key:event[key] for key in ACTION_KEYS}
        if validate_actions([row]) != [row] or identity not in rows:
            raise ValidationError("Project follow-up history does not match its closed action.")
        previous = event.get("previous")
        if "previous" in event:
            if (validate_actions([previous]) != [previous] or previous["id"] != identity
                    or not previous["status"] or previous == row or last.get(identity, previous) != previous):
                raise ValidationError("Invalid project follow-up history.")
        elif not row["status"] or last.get(identity, {}).get("status"):
            raise ValidationError("Invalid project follow-up history.")
        actor = event.get("actor", "")
        if not isinstance(actor, str) or len(actor) > 240 or any(ord(char) < 32 for char in actor):
            raise ValidationError("Invalid project follow-up history.")
        try:
            if not isinstance(stamp, str) or len(stamp) > 40 or datetime.fromisoformat(stamp).tzinfo is None:
                raise ValueError
        except ValueError:
            raise ValidationError("Invalid project follow-up decision time.") from None
        last[identity] = row
        events.append(dict(event))
    for identity, latest in last.items():
        # A reopened action is editable again. A whole-file draft can carry
        # its new decision before the save boundary adds the next receipt.
        if latest["status"] and rows[identity] != latest:
            raise ValidationError("Project follow-up history does not match its closed action.")
    if events:
        result["history"] = events
    return result


def save_project_follow_up(previous, incoming, *, new_file=False, allow_corrections=False, actor=""):
    """Commit decisions with the project bytes; preserve the selected file's prior receipts."""
    before = project_follow_up(previous)
    if not isinstance(incoming, dict):
        raise ValidationError("Project follow-up contains unsupported fields.")
    if "actions" in incoming or "history" in incoming:
        submitted = project_follow_up(incoming)
        actions = reconcile_actions(before["actions"], {"actions":submitted["actions"]}, allow_corrections=allow_corrections)
    else:
        submitted = {}
        actions = reconcile_actions(before["actions"], incoming)
    # Only a new portable copy can acquire an existing trail from the supplied file.
    history = list((submitted if new_file else before).get("history", []))
    remaining = {row["id"] for row in actions}
    if any(event["id"] not in remaining for event in history):
        raise ValidationError("Keep existing follow-up actions. Complete or cancel an action to close it.")
    imported = {event["id"]:event for event in history} if new_file else {}
    now = datetime.now(timezone.utc).isoformat()
    for old, row in action_changes(before["actions"], actions):
        if imported.get(row["id"], {}).get("status") == row["status"]:
            continue
        event = {**row, "at":now}
        if actor:
            event["actor"] = actor
        if old and old["status"]:
            event["previous"] = old
        history.append(event)
    return {"actions":actions, **({"history":history} if history else {})}
