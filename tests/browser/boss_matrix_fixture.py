"""Disposable synthetic BOSS record; no supplier workbook or live state."""
from pathlib import Path
import argparse,json,sys
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'tests'))
from test_boss_matrix_import import SOURCE,CATALOG,sample
from scripts.import_boss_matrix import make_entry
from estimator.server import create_server

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--directory',required=True)
    args=parser.parse_args();folder=Path(args.directory);folder.mkdir(parents=True,exist_ok=True)
    library=folder/'library';library.mkdir()
    record=make_entry(SOURCE,sample(),CATALOG)
    data={'schema_version':1,'notice':'Synthetic BOSS browser fixture','documents':[],'images':[],'links':[],
          'libraries':{'technical':{'filters':[{'key':key,'label':key} for key in ('manufacturer','document','services','orientation')],'items':[record]},
                       'penetration':{'filters':[],'items':[]}}}
    (library/'library.json').write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
    server=create_server(0,folder/'qa.sqlite3',library_directory=library)
    print(json.dumps({'port':server.server_port}),flush=True)
    try:server.serve_forever()
    finally:server.server_close()
