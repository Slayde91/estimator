"""Derived PDF-only lengths and net areas, without takeoff-item authority."""
import math

from .catalog import ValidationError
from .takeoff_model import identity, polyline_length, validate_measurement_scope


def measure_calibration(record, snapshot):
    identifier = identity(record['calibration_id'], 'PDF Measure calibration ID')
    calibration = next((value for value in snapshot['calibrations'] if value['id'] == identifier), None)
    if calibration is None or (calibration['document_id'], calibration['page']) != (record['document_id'], record['page']):
        raise ValidationError('PDF Measure requires a retained calibration on its exact source page.')
    return calibration


def validate_measure_scope(record, snapshot):
    measure_calibration(record, snapshot)
    # The scope helper needs only source/path/basis; this temporary shape is
    # never stored, returned as an item, reviewed, confirmed or transferred.
    validate_measurement_scope(_measurement_shape(record), snapshot)


def _measurement_shape(record):
    area = record['kind'] == 'area'
    return {'mode': 'wall' if area else 'steel',
            'geometry': {'document_id': record['document_id'], 'page': record['page'],
                         'points': record['geometry']['points'],
                         **({'kind': 'polygon', 'exclusions': record['geometry']['exclusions']} if area else {})},
            'measurement': {'method': 'calibrated', 'calibration_id': record['calibration_id']}}


def measure_result(record, snapshot):
    if record['kind'] == 'area':
        return area_result(record, snapshot)
    result = {'id': record['id'], 'version': record['version'], 'status': 'needs_review',
              'length_m': None, 'segments_m': [], 'issues': []}
    try:
        calibration = measure_calibration(record, snapshot)
        validate_measure_scope(record, snapshot)
        scale = calibration['distance_m'] / polyline_length(calibration['points'])
        segments = [math.dist(a, b)*scale for a, b in zip(record['geometry']['points'], record['geometry']['points'][1:])]
        length = math.fsum(segments)
        if not math.isfinite(length) or length <= 0 or any(not math.isfinite(value) or value <= 0 for value in segments):
            raise ValidationError('The PDF Measure length is outside the supported finite range.')
        result.update(status='current', length_m=length, segments_m=segments)
    except ValidationError as error:
        result['issues'].append({'code': 'PDF_MEASURE_SCALE_REVIEW', 'message': str(error)})
    return result


def area_result(record, snapshot):
    result = {'id': record['id'], 'version': record['version'], 'status': 'needs_review',
              'gross_area_m2': None, 'excluded_area_m2': None, 'net_area_m2': None, 'label_point_pdf': None, 'issues': []}
    try:
        validate_measure_scope(record, snapshot)
        from .takeoff_area import measured_area
        from .takeoff_markup_pdf import surface_label_point
        result.update(status='current', **measured_area(_measurement_shape(record), snapshot),
                      label_point_pdf=surface_label_point(record['geometry']))
    except ValidationError as error:
        result['issues'].append({'code': 'PDF_AREA_SCALE_REVIEW', 'message': str(error)})
    return result


def measure_results(snapshot):
    return [measure_result(record, snapshot) for record in snapshot.get('graphics', {}).get('records', [])
            if record['kind'] in ('measure', 'area')]
