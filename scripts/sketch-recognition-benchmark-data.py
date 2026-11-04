"""Prepare a small, immutable public QuickDraw benchmark outside the repository.

Default is offline planning. --download fetches bounded public data only, never
executes downloaded code, loads pickle, trains models or contacts AWS services.
"""
import argparse
import ast
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import struct
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / 'config/sketch-recognition-benchmark.json'
DEFAULT_OUTPUT = Path.home() / '.game-studio-development/sketch-recognition-evaluation-20261104'
BASE = 'https://storage.googleapis.com/quickdraw_dataset/full/'


def digest(value): return hashlib.sha256(value).hexdigest()


def save(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=True) + '\n')
    temporary.chmod(0o600); temporary.replace(path)


def npy_header(data):
    """Parse only the bounded literal uint8 header; no NumPy/pickle execution."""
    if data[:6] != b'\x93NUMPY': raise ValueError('Expected a public NPY file.')
    version = data[6:8]
    if version == b'\x01\x00': start, length = 10, struct.unpack('<H',data[8:10])[0]
    elif version in {b'\x02\x00',b'\x03\x00'}: start, length = 12,struct.unpack('<I',data[8:12])[0]
    else: raise ValueError('Unsupported public NPY header version.')
    if not 1 <= length <= 1000 or len(data) < start+length: raise ValueError('NPY header exceeds its bound.')
    header = ast.literal_eval(data[start:start+length].decode('ascii').strip())
    if (not isinstance(header,dict) or set(header)!={'descr','fortran_order','shape'} or
            header['descr']!='|u1' or header['fortran_order'] is not False or
            not isinstance(header['shape'],tuple) or len(header['shape'])!=2 or
            type(header['shape'][0]) is not int or not 50040<=header['shape'][0]<=1000000 or header['shape'][1]!=784):
        raise ValueError('Only bounded 28x28 uint8 bitmap matrices are allowed.')
    return {'dataOffset':start+length,'shape':list(header['shape']),'dtype':'uint8'}


def ranged(url, start=None, end=None, tail=None, expected=None):
    value = 'bytes=-'+str(tail) if tail else 'bytes='+str(start)+'-'+str(end)
    maximum = tail if tail else end-start+1
    headers={'Range':value,'Accept-Encoding':'identity','User-Agent':'Game-Studio-public-benchmark'}
    if expected: headers['If-Match']=expected['etag']
    with urlopen(Request(url,headers=headers),timeout=25) as response:
        body=response.read(maximum+1)
        content=response.headers.get('Content-Range','')
        match=re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)',content)
        if response.status!=206 or len(body)>maximum or not match or int(match[2])-int(match[1])+1!=len(body):
            raise ValueError('Public data server did not honor the bounded range.')
        if not tail and (int(match[1])!=start or int(match[2])!=end): raise ValueError('Public byte range changed.')
        metadata={'url':url,'etag':response.headers.get('ETag'),'generation':response.headers.get('x-goog-generation'),
            'contentLength':int(match[3]),'contentRange':content,'sha256':digest(body),'bytes':len(body)}
        if not metadata['etag'] or not metadata['generation']: raise ValueError('Public object provenance is missing.')
        if expected and any(metadata[key]!=expected[key] for key in ('etag','generation','contentLength')): raise ValueError('Public object changed during collection.')
        return body,metadata


def bitmap_category(category, spec, directory):
    name=category.replace('_',' ');url=BASE+'numpy_bitmap/'+quote(name,safe='')+'.npy'
    header,meta=ranged(url,0,1023);shape=npy_header(header)
    first,count=spec['bitmap']['startRow'],spec['bitmap']['rowsPerClass']
    if first<50000 or first+count>shape['shape'][0]: raise ValueError('Selected rows cross the documented training boundary.')
    start=shape['dataOffset']+first*784
    body,selected=ranged(url,start,start+count*784-1,expected=meta)
    path=directory/(category+'.uint8');path.write_bytes(body);path.chmod(0o600)
    return {'class':category,'sourceCategory':name,'file':str(path.relative_to(directory.parent)),
        'header':{**meta,**shape},'selected':selected,'rowIndices':list(range(first,first+count)),
        'calibrationRowIndices':list(range(first,first+spec['bitmap']['calibrationRows'])),
        'acceptanceRowIndices':list(range(first+spec['bitmap']['calibrationRows'],first+count))}


def valid_drawing(value):
    if not isinstance(value,list) or not 1<=len(value)<=384:return False
    total=0
    for stroke in value:
        if not isinstance(stroke,list) or len(stroke)!=2 or not all(isinstance(axis,list) for axis in stroke) or len(stroke[0])!=len(stroke[1]) or not 1<=len(stroke[0])<=8000:return False
        if any(type(point) is not int or not 0<=point<=255 for axis in stroke for point in axis):return False
        total+=len(stroke[0])
    return 3<=total<=8000


def select_strokes(body, category, seed, count):
    # A suffix range can begin inside a JSON line; discard only that incomplete
    # line. No recognized/quality/country/timestamp filter is applied.
    rows=[];invalid=0
    for line in body.split(b'\n')[1:]:
        if not line.strip():continue
        try:row=json.loads(line)
        except (ValueError,UnicodeDecodeError):invalid+=1;continue
        if (not isinstance(row,dict) or row.get('word')!=category.replace('_',' ') or not isinstance(row.get('key_id'),str)
                or not row['key_id'].isdigit() or type(row.get('recognized')) is not bool or not valid_drawing(row.get('drawing'))):
            invalid+=1;continue
        rows.append({'key_id':row['key_id'],'word':row['word'],'recognized':row['recognized'],'drawing':row['drawing']})
    if len({row['key_id'] for row in rows})!=len(rows):raise ValueError('Duplicate public drawing identifier.')
    rows.sort(key=lambda row:digest((seed+':'+category+':'+row['key_id']).encode()))
    if len(rows)<count:raise ValueError('Public tail window has too few bounded drawings.')
    return rows[:count],{'validWindowRows':len(rows),'invalidOrOutOfBoundsRows':invalid,'recognizedFilterApplied':False}


def stroke_category(category,spec,directory):
    url=BASE+'simplified/'+quote(category.replace('_',' '),safe='')+'.ndjson'
    body,meta=ranged(url,tail=spec['stroke']['tailBytes'])
    rows,selection=select_strokes(body,category,spec['seed'],spec['stroke']['rowsPerClass'])
    path=directory/(category+'.json');save(path,rows)
    return {'class':category,'file':str(path.relative_to(directory.parent)),'source':meta,
        'selectedSha256':digest(path.read_bytes()),'samples':len(rows),
        'recognizedTrue':sum(row['recognized'] for row in rows),'recognizedFalse':sum(not row['recognized'] for row in rows),**selection}


def collect(output):
    output=output.resolve()
    if output==ROOT or output.is_relative_to(ROOT):raise ValueError('Human benchmark records must remain outside the repository.')
    output.mkdir(parents=True,exist_ok=True);output.chmod(0o700)
    manifest=output/'BENCHMARK_DATA_MANIFEST.json'
    if manifest.exists():raise ValueError('The frozen human benchmark already exists. Do not overwrite it.')
    spec_bytes=SPEC.read_bytes();spec=json.loads(spec_bytes)
    classes=list(spec['primaryClassToPrompt'])+spec['negativeClasses']
    if len(classes)!=len(set(classes)) or len(classes)>50 or spec['bitmap']['rowsPerClass']!=40:raise ValueError('Benchmark scope changed; review the download bound.')
    result={'version':1,'createdAt':datetime.now(timezone.utc).isoformat(),'specSha256':digest(spec_bytes),'spec':spec,
        'license':'CC-BY-4.0','attribution':'Quick, Draw! Dataset, Google, Inc.','sourceURL':'https://github.com/googlecreativelab/quickdraw-dataset',
        'bitmap':[],'stroke':[],'modelCalls':0,'trainingPerformed':False,'remoteCodeExecuted':False}
    for kind,categories,operation in [('bitmap',classes,bitmap_category),('stroke',spec['strokeClasses'],stroke_category)]:
        directory=output/('human-'+kind);directory.mkdir(exist_ok=True);directory.chmod(0o700)
        with ThreadPoolExecutor(max_workers=4) as pool:
            pending={pool.submit(operation,category,spec,directory):category for category in categories}
            for future in as_completed(pending):
                result[kind].append(future.result());save(output/'BENCHMARK_DATA_MANIFEST.partial.json',result)
        result[kind].sort(key=lambda item:item['class'])
        print(json.dumps({'stage':kind,'classes':len(result[kind]),'samples':sum(len(item['rowIndices']) if kind=='bitmap' else item['samples'] for item in result[kind])}),flush=True)
    result['completedAt']=datetime.now(timezone.utc).isoformat();save(manifest,result)
    (output/'BENCHMARK_DATA_MANIFEST.partial.json').unlink()
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--download',action='store_true');parser.add_argument('--output',type=Path,default=DEFAULT_OUTPUT)
    args=parser.parse_args()
    if not args.download:
        spec=json.loads(SPEC.read_text());print(json.dumps({'status':'OFFLINE_PLAN','publicBitmapClasses':len(spec['primaryClassToPrompt'])+len(spec['negativeClasses']),'bitmapRowsPerClass':40,'publicStrokeClasses':len(spec['strokeClasses']),'strokeRowsPerClass':40,'output':str(args.output),'networkRequests':0,'training':False}));return
    collect(args.output)


if __name__=='__main__':main()
