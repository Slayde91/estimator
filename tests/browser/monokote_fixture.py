"""Disposable rendered QA; synthetic assessment by default, never production trust."""
from hashlib import sha256
import json
import os
from pathlib import Path
import sys
import tempfile

from standard_fixture import ROOT, main

sys.path.insert(0, str(ROOT / 'tests'))
from estimator import monokote_hollow


if __name__ == '__main__':
    output = Path(sys.argv[sys.argv.index('--directory') + 1]).resolve()
    output.mkdir(parents=True, exist_ok=True)
    private_evidence = bool(os.environ.get('CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY'))
    temporary = None
    if not private_evidence:
        # The helper contains invented test numbers, not report table content.
        from test_monokote_hollow import synthetic_dataset
        temporary = tempfile.TemporaryDirectory(prefix='ceasefire-synthetic-assessment-')
        payload = json.dumps(synthetic_dataset(), separators=(',', ':')).encode()
        (Path(temporary.name) / monokote_hollow.DATASET_FILENAME).write_bytes(payload)
        monokote_hollow.DATASET_SHA256 = sha256(payload).hexdigest()
        os.environ['CEASEFIRE_CALCULATOR_EVIDENCE_DIRECTORY'] = temporary.name
    assessment = monokote_hollow.load_assessment()
    if assessment.error:
        raise RuntimeError(assessment.error)
    # Independent expected coordinate: named member factor122 takes upper row125.
    expected = assessment.tables[3].values[19][4]
    (output / 'monokote-fixture.json').write_text(json.dumps({
        'evidence_mode': 'private reviewed report' if private_evidence else 'SYNTHETIC TEST DATA — NOT FOR DESIGN',
        'synthetic': not private_evidence,
        'assessment_digest': assessment.digest,
        'named_case_thickness': expected,
    }), encoding='utf-8')
    try:
        main()
    finally:
        if temporary:
            temporary.cleanup()
