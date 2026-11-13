"""Portable follow-up fields shared by Projects and Leads."""

from datetime import date

from .catalog import ValidationError


FOLLOW_UP_LIMITS = {"next_action": 500, "follow_up_date": 10}


def validate_follow_up_date(value):
    if value:
        try:
            if date.fromisoformat(value).isoformat() != value:
                raise ValueError
        except ValueError:
            raise ValidationError("Enter a valid follow-up date.") from None


def project_follow_up(values):
    if not isinstance(values, dict) or values.keys() - FOLLOW_UP_LIMITS.keys():
        raise ValidationError("Project follow-up contains unsupported fields.")
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
