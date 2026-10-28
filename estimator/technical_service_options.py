"""Approved Technical Library Services choices, separate from pricing routes.

The calculator's original ordered SERVICES tuple stays unchanged. Additional
library descriptions are available for reviewed discovery assignments only.
"""
from .library_facets import SERVICES


TECHNICAL_SERVICES = (
    *SERVICES,
    'PP pipe',
    'CPVC pipe',
    'Unlagged Iron Pipes',
    'Lagged Iron Pipes',
    'Beverage / Beer Lines',
    'Raupiano Plus pipe',
    'Unlagged Brass Pipes',
    'dBlue pipe',
    'PU air line',
    'Concentric plastic pipe',
    'Smoke Sampling Tubes',
    'ABS pipe',
    'PB pipe',
    'Insulated Gas Lines',
    'Kelox / KeKilit pipe',
)


def options(values):
    """Return only the approved choices; observed custom values stay on records.

    As with calculator choices, observing a source token is not permission to
    introduce another dropdown option. Return a fresh list for each caller.
    """
    return list(TECHNICAL_SERVICES)
