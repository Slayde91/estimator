"""Bounded polygon topology and unrounded surface measurements in PDF space.

Rings are implicitly closed. Holes remove area exactly once and must lie
strictly inside their boundary. No footprint-to-wall-face inference occurs.
"""

from fractions import Fraction
import math
import sys

from .catalog import ValidationError

AREA_MODES = ('wall', 'slab')
MAX_AREA_VERTICES = 1000
MAX_AREA_EXCLUSIONS = 64


def _orientation(a, b, c):
    left = (b[0] - a[0]) * (c[1] - a[1])
    right = (b[1] - a[1]) * (c[0] - a[0])
    cross = left - right
    # Resolve cancellation using the exact represented input values, not an
    # arbitrary geometric tolerance that could accept crossing boundaries.
    if abs(cross) > 8 * sys.float_info.epsilon * (abs(left) + abs(right)):
        return 1 if cross > 0 else -1
    ax, ay, bx, by, cx, cy = map(Fraction, (*a, *b, *c))
    exact = (bx-ax)*(cy-ay) - (by-ay)*(cx-ax)
    return (exact > 0) - (exact < 0)


def _on_segment(a, b, p):
    return (min(a[0], b[0]) <= p[0] <= max(a[0], b[0])
            and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])
            and _orientation(a, b, p) == 0)


def _intersects(a, b, c, d):
    if (max(a[0], b[0]) < min(c[0], d[0]) or max(c[0], d[0]) < min(a[0], b[0])
            or max(a[1], b[1]) < min(c[1], d[1]) or max(c[1], d[1]) < min(a[1], b[1])):
        return False
    ab_c, ab_d, cd_a, cd_b = (_orientation(a, b, c), _orientation(a, b, d),
                             _orientation(c, d, a), _orientation(c, d, b))
    return (ab_c * ab_d < 0 and cd_a * cd_b < 0
            or ab_c == 0 and _on_segment(a, b, c)
            or ab_d == 0 and _on_segment(a, b, d)
            or cd_a == 0 and _on_segment(c, d, a)
            or cd_b == 0 and _on_segment(c, d, b))


def _edges(ring):
    return list(zip(ring, ring[1:] + ring[:1]))


def ring_area(ring):
    origin = ring[0]
    shifted = [(p[0]-origin[0], p[1]-origin[1]) for p in ring]
    return abs(math.fsum(a[0]*b[1] - b[0]*a[1] for a, b in _edges(shifted))) / 2


def _inside(point, ring):
    inside = False
    for a, b in _edges(ring):
        if _on_segment(a, b, point):
            return False
        if (a[1] > point[1]) != (b[1] > point[1]):
            orientation = _orientation(a, b, point)
            if (orientation > 0) == (b[1] > a[1]):
                inside = not inside
    return inside


def _validate_ring(ring):
    if len({tuple(point) for point in ring}) != len(ring):
        raise ValidationError('Polygon vertices must be distinct; the closing edge is automatic.')
    edges = _edges(ring)
    for index, (a, b) in enumerate(edges):
        previous = ring[index-1]
        # Adjacent edges can meet only at their shared vertex, not double back.
        if _orientation(previous, a, b) == 0 and (_on_segment(previous, a, b) or _on_segment(a, b, previous)):
            raise ValidationError('A polygon cannot double back along an adjacent edge.')
    # Sweep edge bounding boxes before exact predicates. Ordinary detailed
    # boundaries stay fast; the vertex budget still bounds worst-case overlap.
    ordered = sorted((min(a[0], b[0]), max(a[0], b[0]), index, a, b)
                     for index, (a, b) in enumerate(edges))
    active = []
    for low, high, index, a, b in ordered:
        active = [edge for edge in active if edge[0] >= low]
        for _, other, c, d in active:
            if abs(index-other) == 1 or {index, other} == {0, len(edges)-1}:
                continue
            if _intersects(a, b, c, d):
                raise ValidationError('Polygon boundaries cannot cross or touch themselves.')
        active.append((high, index, a, b))
    if not math.isfinite(ring_area(ring)) or ring_area(ring) <= 0:
        raise ValidationError('A polygon must enclose a positive surface area.')


def validate_polygon(geometry, page):
    # Local import avoids making the shared linear model depend on this module
    # during initialization; common UUID/number/page rules remain authoritative.
    from .takeoff_model import identity, object_fields, points, text
    keys = {'kind', 'document_id', 'page', 'points', 'exclusions'}
    object_fields(geometry, keys, 'Surface polygon', keys)
    if geometry['kind'] != 'polygon':
        raise ValidationError('A wall or slab surface requires polygon geometry.')
    holes = geometry['exclusions']
    if not isinstance(holes, list) or len(holes) > MAX_AREA_EXCLUSIONS:
        raise ValidationError(f'A surface supports at most {MAX_AREA_EXCLUSIONS} explicit exclusions.')
    rings = [points(geometry['points'], 'Surface polygon', page, 3, MAX_AREA_VERTICES)]
    ids = set()
    vertices = len(rings[0])
    for hole in holes:
        object_fields(hole, {'id', 'points', 'note'}, 'Surface exclusion', {'id', 'points', 'note'})
        identifier = identity(hole['id'], 'Exclusion ID')
        if identifier in ids:
            raise ValidationError('Surface exclusion IDs must be distinct.')
        ids.add(identifier)
        text(hole['note'], 'Exclusion note')
        ring = points(hole['points'], 'Exclusion polygon', page, 3, MAX_AREA_VERTICES)
        vertices += len(ring)
        if vertices > MAX_AREA_VERTICES:
            raise ValidationError(f'A surface and all its exclusions support at most {MAX_AREA_VERTICES} vertices in total.')
        rings.append(ring)
    for ring in rings:
        _validate_ring(ring)
    for index, ring in enumerate(rings[1:], 1):
        if not _inside(ring[0], rings[0]):
            raise ValidationError('Each exclusion must lie strictly inside the surface boundary.')
        for other in rings[:index]:
            if any(_intersects(a, b, c, d) for a, b in _edges(ring) for c, d in _edges(other)):
                raise ValidationError('Exclusions cannot touch or cross another boundary.')
            if other is not rings[0] and (_inside(ring[0], other) or _inside(other[0], ring)):
                raise ValidationError('Exclusions cannot overlap or contain another exclusion.')
    if ring_area(rings[0]) <= math.fsum(ring_area(ring) for ring in rings[1:]):
        raise ValidationError('Exclusions must leave a positive net surface area.')


def measured_area(item, snapshot):
    from .takeoff_model import page_metadata, polyline_length
    geometry, measurement = item['geometry'], item['measurement']
    if not geometry or not measurement or measurement.get('method') != 'calibrated':
        raise ValidationError('Trace a surface polygon and choose its own page calibration.')
    _, page = page_metadata(snapshot, geometry['document_id'], geometry['page'])
    validate_polygon(geometry, page)
    calibration = next((c for c in snapshot['calibrations'] if c['id'] == measurement['calibration_id']), None)
    if not calibration or (calibration['document_id'], calibration['page']) != (geometry['document_id'], geometry['page']) or calibration['uniform_scale'] is not True:
        raise ValidationError('Surface area requires a uniform calibration on its own source page.')
    scale = calibration['distance_m'] / polyline_length(calibration['points'])
    gross = ring_area(geometry['points']) * scale * scale
    excluded = math.fsum(ring_area(hole['points']) for hole in geometry['exclusions']) * scale * scale
    net = gross - excluded
    if any(not math.isfinite(value) or not 0 <= value <= 1e16 for value in (gross, excluded, net)) or net <= 0:
        raise ValidationError('Surface measurements must retain a finite positive net area within the supported range.')
    return {'gross_area_m2': gross, 'excluded_area_m2': excluded, 'net_area_m2': net}
