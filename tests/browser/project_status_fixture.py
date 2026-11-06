"""Disposable project pipeline fixture, never the live database or quotes folder."""
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from estimator.project_file import export_project
from estimator.server import create_server
from estimator.storage import Store

directory = Path(sys.argv[1]).resolve()
directory.mkdir(parents=True, exist_ok=True)
store = Store(directory / "state.sqlite3")
store.set_project_folder(directory)
payload = json.loads(export_project(store, {"estimate": {"title": "Pipeline fixture"}}))
for index, status in enumerate(["Draft", "Draft", "Review", "Presented", "Accepted", "Lost"]):
    payload["project_status"] = status
    payload["estimate"]["title"] = f"Project {index + 1}"
    (directory / f"Project-{index + 1}.cf.json").write_text(json.dumps(payload), encoding="utf-8")
server = create_server(0, store.path)
print(json.dumps({"port": server.server_port}), flush=True)
try:
    server.serve_forever()
finally:
    server.server_close()
