"""Offline, label-blind comparison on frozen public human QuickDraw samples.

Use the private evaluation virtual environment. No network/provider calls occur.
Calibration and acceptance are separate fixed slices; pen variants are allowed
only for calibration. Human source drawings and results stay outside Git.
"""
import argparse
from collections import defaultdict
from contextlib import nullcontext
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import socket
import statistics
import time
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
DEFAULT=Path.home()/'.game-studio-development/sketch-recognition-evaluation-20261104'


def digest(value):return hashlib.sha256(value).hexdigest()


def load_module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


def strokes_for(drawing,fraction=1.0):
    """Expose only an ordered point prefix on a centered 500px square board."""
    budget=max(1,math.ceil(sum(len(stroke[0]) for stroke in drawing)*fraction))
    result=[]
    for xs,ys in drawing:
        count=min(budget,len(xs))
        if not count:break
        points=[[.1875+.625*x/255,y/255] for x,y in zip(xs[:count],ys[:count])]
        # Match the online canvas' bounded wire segments without joining pens.
        start=0
        while start<len(points):
            line=points[start:start+120]
            result.append({'color':'#244b50','width':5,'points':line})
            if start+120>=len(points):break
            start+=119
        budget-=count
    return result


def bitmap_strokes(bitmap):
    """Convert visible raster runs for the geometry-only historical baseline.

    This adapter is reported separately; the original baseline accepted vectors,
    not bitmap files. Neither input labels nor correct answers are consulted.
    """
    rows=[]
    for y in range(28):
        x=0
        while x<28:
            if bitmap[y,x]<128:x+=1;continue
            start=x
            while x+1<28 and bitmap[y,x+1]>=128:x+=1
            points=[[.1875+.625*(start+.5)/28,(y+.5)/28]]
            if x!=start:points.append([.1875+.625*(x+.5)/28,(y+.5)/28])
            rows.append({'color':'#244b50','width':5,'points':points});x+=1
    return rows


def mapped_guesses(predictions,mapping,threshold):
    results=[]
    for item in predictions:
        if set(item)!={'label','score'} or not isinstance(item['label'],str) or not math.isfinite(float(item['score'])) or not 0<=float(item['score'])<=1:
            raise ValueError('Unsupported local classifier output.')
        prompt=mapping.get(item['label'].lower().replace(' ','_'))
        if prompt and item['score']>=threshold and prompt not in results:results.append(prompt)
        if len(results)==3:break
    return results


def metrics(rows):
    positive=[row for row in rows if row['expectedPrompt'] is not None]
    negative=[row for row in rows if row['expectedPrompt'] is None]
    result={'samples':len(rows),'positiveSamples':len(positive),'negativeSamples':len(negative)}
    for model in ['baseline','cnn']:
        top1=sum(row[model][:1]==[row['expectedPrompt']] for row in positive)
        top3=sum(row['expectedPrompt'] in row[model] for row in positive)
        result[model]={'top1':top1/len(positive) if positive else None,'top3':top3/len(positive) if positive else None,
            'positiveGuessCoverage':sum(bool(row[model]) for row in positive)/len(positive) if positive else None,
            'negativeFalseGuessRate':sum(bool(row[model]) for row in negative)/len(negative) if negative else None}
    return result


def check_acceptance_selection(frozen,threshold,source_hash,numpy_version,pillow_version):
    if (frozen.get('status')!='FROZEN_BEFORE_ACCEPTANCE' or frozen.get('confidence')!=threshold or
            frozen.get('runtimeSha256')!=source_hash or frozen.get('numpy')!=numpy_version or frozen.get('pillow')!=pillow_version):
        raise ValueError('Acceptance differs from the frozen calibration selection/runtime.')


def run(directory,split,threshold,pen=None):
    import numpy as np
    import PIL
    directory=directory.resolve()
    if directory.is_relative_to(ROOT):raise ValueError('Human evaluation/results must remain outside Git.')
    manifest=json.loads((directory/'BENCHMARK_DATA_MANIFEST.json').read_text());spec=manifest['spec']
    if digest((ROOT/'config/sketch-recognition-benchmark.json').read_bytes())!=manifest['specSha256']:raise ValueError('Frozen benchmark specification changed.')
    if split=='acceptance' and pen is not None:raise ValueError('Acceptance uses the frozen production renderer without calibration overrides.')
    source=ROOT/'backend/nce_api/sketch_vision.py';baseline_path=directory/'template-baseline.py'
    frozen=None
    if split=='acceptance':
        frozen=json.loads((directory/'CALIBRATION_SELECTION_FROZEN.json').read_text())
        check_acceptance_selection(frozen,threshold,digest(source.read_bytes()),np.__version__,PIL.__version__)
    if not baseline_path.exists():raise ValueError('Freeze the original repository template baseline before evaluating.')
    baseline=load_module('benchmark_template_baseline',baseline_path);vision=load_module('benchmark_cnn',source)
    mapping={**spec['primaryClassToPrompt'],'cake':'birthday cake'}
    rows=[];latencies=[]
    def evaluate(dataset,category,sample_id,strokes,bitmap=None,fraction=1.0,recognized=None):
        expected=spec['primaryClassToPrompt'].get(category)
        start=time.perf_counter()
        try:old=baseline.rank_guesses(strokes)
        except ValueError:old=[]
        old_ms=(time.perf_counter()-start)*1000
        start=time.perf_counter()
        raw=vision.predict_bitmap(bitmap) if bitmap is not None else vision.predict(strokes)
        cnn_ms=(time.perf_counter()-start)*1000
        latencies.append(cnn_ms)
        rows.append({'dataset':dataset,'class':category,'sampleId':str(sample_id),'fraction':fraction,'recognizedByOriginalQuickDraw':recognized,
            'expectedPrompt':expected,'labelGroup':'negative' if expected is None else 'declared-alias' if category in spec['declaredAliases'] else 'exact',
            'baseline':old,'cnn':mapped_guesses(raw,mapping,threshold),'rawCnn':raw,'baselineMs':old_ms,'cnnMs':cnn_ms})
    if pen is not None:
        from PIL import ImageFilter
        original=ImageFilter.MaxFilter
        variant=patch.object(ImageFilter,'MaxFilter',side_effect=lambda ignored:original(pen))
    else:variant=nullcontext()
    # A network attempt fails the benchmark, including accidental provider use.
    with patch.object(socket,'socket',side_effect=AssertionError('No network during offline benchmark.')),patch.object(socket,'create_connection',side_effect=AssertionError('No network during offline benchmark.')),variant:
        for item in manifest['bitmap']:
            raw=(directory/item['file']).read_bytes()
            if digest(raw)!=item['selected']['sha256']:raise ValueError('Frozen bitmap samples changed.')
            images=np.frombuffer(raw,dtype=np.uint8).reshape(-1,28,28)
            selected=item['calibrationRowIndices'] if split=='calibration' else item['acceptanceRowIndices']
            for index,image in zip(item['rowIndices'],images):
                if index in selected:evaluate('documented-recipe-heldout-bitmap',item['class'],index,bitmap_strokes(image),bitmap=image)
        for item in manifest['stroke']:
            path=directory/item['file']
            if digest(path.read_bytes())!=item['selectedSha256']:raise ValueError('Frozen stroke samples changed.')
            samples=json.loads(path.read_text());samples=samples[:20] if split=='calibration' else samples[20:]
            for sample in samples:
                for fraction in spec['stroke']['partialPointFractions']:
                    evaluate('human-strokes-overlap-unverified',item['class'],sample['key_id'],strokes_for(sample['drawing'],fraction),fraction=fraction,recognized=sample['recognized'])
    groups=defaultdict(list)
    for row in rows:
        groups[(row['dataset'],row['fraction'],'all')].append(row)
        groups[(row['dataset'],row['fraction'],row['labelGroup'])].append(row)
    summary=[{'dataset':dataset,'fraction':fraction,'group':group,**metrics(group_rows)} for (dataset,fraction,group),group_rows in sorted(groups.items())]
    threshold_grid=[]
    if split=='calibration':
        for value in [.1,.15,.2,.25,.3,.4,.5]:
            alternate=[{**row,'cnn':mapped_guesses(row['rawCnn'],mapping,value)} for row in rows]
            threshold_grid.append({'threshold':value,'bitmap':metrics([row for row in alternate if row['dataset']=='documented-recipe-heldout-bitmap']),
                'completeStrokes':metrics([row for row in alternate if row['dataset']=='human-strokes-overlap-unverified' and row['fraction']==1.0])})
    result={'version':1,'split':split,'threshold':threshold,'calibrationPenOverride':pen,'modelVersion':vision.MODEL_VERSION,
        'runtimeVersions':{'numpy':np.__version__,'Pillow':PIL.__version__},
        'frozenSelectionSha256':digest((directory/'CALIBRATION_SELECTION_FROZEN.json').read_bytes()) if frozen else None,
        'modelSourceSha256':digest(source.read_bytes()),'baselineSourceSha256':digest(baseline_path.read_bytes()),'dataManifestSha256':digest((directory/'BENCHMARK_DATA_MANIFEST.json').read_bytes()),
        'inputSamples':len(rows),'localCnnInferences':len(rows),'paidProviderCalls':0,'networkCalls':0,'trainingPerformed':False,
        'latencyMs':{'first':latencies[0],'median':statistics.median(latencies),'p95':sorted(latencies)[math.ceil(.95*len(latencies))-1]},
        'summary':summary,'thresholdCalibration':threshold_grid,'perClass':[{'class':category,**metrics([row for row in rows if row['class']==category and row['dataset']=='documented-recipe-heldout-bitmap'])} for category in sorted({row['class'] for row in rows})],
        'limitations':[spec['bitmap']['scope'],spec['stroke']['scope'],'Bitmap baseline uses a declared raster-run adapter; stroke comparisons call both original/new vector APIs.','Partial prefixes expose ordered points only; no final bounding box, current secret prompt or answer enters either predictor.'],
        'rows':rows}
    label=split+('-pen'+str(pen) if pen is not None else '')+'-threshold'+str(threshold)+'-numpy'+np.__version__+'-Pillow'+PIL.__version__
    path=directory/('BENCHMARK-'+label+'.json')
    if path.exists():raise ValueError('Do not overwrite a completed benchmark result.')
    path.write_text(json.dumps(result,indent=2)+'\n');path.chmod(0o600)
    print(json.dumps({key:result[key] for key in ['split','threshold','calibrationPenOverride','inputSamples','latencyMs','summary','thresholdCalibration']},indent=2))
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--run',action='store_true');parser.add_argument('--directory',type=Path,default=DEFAULT);parser.add_argument('--split',choices=['calibration','acceptance'],default='calibration');parser.add_argument('--threshold',type=float,default=.25);parser.add_argument('--pen-diameter',type=int,choices=[3,5,7])
    args=parser.parse_args()
    if not 0<args.threshold<=1:raise ValueError('Threshold must be a global probability.')
    if args.run:run(args.directory,args.split,args.threshold,args.pen_diameter)
    else:print(json.dumps({'status':'OFFLINE_PLAN','split':args.split,'threshold':args.threshold,'directory':str(args.directory),'networkCalls':0,'modelInferences':0}))


if __name__=='__main__':main()
