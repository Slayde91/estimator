"""Derived PDF-only lengths; these records never become takeoff items."""
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
    validate_measurement_scope({'mode': 'steel', 'geometry': {'document_id': record['document_id'],
        'page': record['page'], 'points': record['geometry']['points']},
        'measurement': {'method': 'calibrated', 'calibration_id': record['calibration_id']}}, snapshot)


def measure_result(record, snapshot):
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


def measure_results(snapshot):
    return [measure_result(record, snapshot) for record in snapshot.get('graphics', {}).get('records', [])
            if record['kind'] == 'measure']
