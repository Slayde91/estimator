"""Human-readable calendar dates for reports. Project data retains its native representation."""
from datetime import date
import re

_MONTHS = ('January','February','March','April','May','June','July','August','September','October','November','December')
_SOURCE_DATE = re.compile(r'\b(\d{1,2}) ('+'|'.join(_MONTHS)+r') (\d{4})\b')


def display_date(value):
    """Convert a stored ISO calendar date, preserving historical free-text values."""
    if isinstance(value,date):
        return f'{value.day:02d}/{value.month:02d}/{value.year:04d}'
    if isinstance(value,str) and re.fullmatch(r'\d{4}-\d\d-\d\d',value):
        try:
            return display_date(date.fromisoformat(value))
        except ValueError:
            pass
    return value


def display_source_dates(caption):
    """Format calendar dates in generated assessment captions without changing reference data."""
    def replace(match):
        day,month,year = match.groups()
        try:
            return display_date(date(int(year),_MONTHS.index(month)+1,int(day)))
        except ValueError:
            return match[0]
    return _SOURCE_DATE.sub(replace,caption)
