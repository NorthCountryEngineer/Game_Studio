"""Synthetic benchmark-tool guards; no public human drawings or network."""
import importlib.util
import json
from pathlib import Path
import struct
import unittest

ROOT=Path(__file__).resolve().parents[2]


def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


data=module('test_sketch_benchmark_data',ROOT/'scripts/sketch-recognition-benchmark-data.py')
bench=module('test_sketch_benchmark_runner',ROOT/'scripts/benchmark-sketch-recognition.py')


class BenchmarkToolTests(unittest.TestCase):
    def header(self,description):
        body=(repr(description)+'\n').encode();return b'\x93NUMPY\x01\x00'+struct.pack('<H',len(body))+body

    def test_npy_header_offset_is_parsed_rather_than_assumed(self):
        raw=self.header({'descr':'|u1','fortran_order':False,'shape':(100000,784)})
        result=data.npy_header(raw)
        self.assertEqual(result['dataOffset'],len(raw));self.assertEqual(result['shape'],[100000,784])
        for change in ({'descr':'|O'},{'fortran_order':True},{'shape':(50000,784)},{'shape':(100000,100000)}):
            with self.assertRaises(ValueError):data.npy_header(self.header({'descr':'|u1','fortran_order':False,'shape':(100000,784),**change}))

    def test_header_never_evaluates_executable_expressions(self):
        body=b"__import__('os').system('false')\n"
        with self.assertRaises(ValueError):data.npy_header(b'\x93NUMPY\x01\x00'+struct.pack('<H',len(body))+body)

    def test_stroke_selection_keeps_recognized_and_unrecognized_records(self):
        rows=[{'key_id':str(index),'word':'cat','recognized':index%2==0,'drawing':[[[0,120,255],[0,120,255]]]} for index in range(20)]
        body=b'incomplete first line\n'+b'\n'.join(json.dumps(row).encode() for row in rows)+b'\n'
        selected,report=data.select_strokes(body,'cat','fixed-seed',20)
        self.assertEqual(sum(row['recognized'] for row in selected),10)
        self.assertEqual(report['recognizedFilterApplied'],False)
        self.assertEqual(selected,data.select_strokes(body,'cat','fixed-seed',20)[0])

    def test_partial_prefix_does_not_read_future_points_or_join_pen_strokes(self):
        drawing=[[[0,10,20,30],[0,10,20,30]],[[200,220,240,255],[200,220,240,255]]]
        partial=bench.strokes_for(drawing,.5)
        self.assertEqual(len(partial),1);self.assertEqual(len(partial[0]['points']),4)
        self.assertLess(max(point[0] for point in partial[0]['points']),.3)
        full=bench.strokes_for(drawing,1)
        self.assertEqual(len(full),2)
        self.assertAlmostEqual(full[1]['points'][-1][0],.8125)
        self.assertEqual(full[1]['points'][-1][1],1)

    def test_wire_chunking_keeps_long_human_strokes_bounded(self):
        drawing=[[[index%256 for index in range(300)],[index%256 for index in range(300)]]]
        strokes=bench.strokes_for(drawing)
        self.assertTrue(all(len(stroke['points'])<=120 for stroke in strokes))
        self.assertEqual(strokes[0]['points'][-1],strokes[1]['points'][0])

    def test_guesses_use_fixed_global_mapping_and_scores_without_answer_input(self):
        predictions=[{'label':'dog','score':.7},{'label':'cat','score':.2},{'label':'cake','score':.1}]
        self.assertEqual(bench.mapped_guesses(predictions,{'cat':'sleeping cat','cake':'birthday cake'},.25),[])
        self.assertEqual(bench.mapped_guesses(predictions,{'cat':'sleeping cat','cake':'birthday cake'},.1),['sleeping cat','birthday cake'])
        with self.assertRaises(ValueError):bench.mapped_guesses([{'label':'cat','score':float('nan')}],{'cat':'sleeping cat'},.1)

    def test_acceptance_cannot_change_selected_threshold_renderer_or_runtime(self):
        frozen={'status':'FROZEN_BEFORE_ACCEPTANCE','confidence':.25,'runtimeSha256':'frozen','numpy':'test-numpy','pillow':'test-pillow'}
        bench.check_acceptance_selection(frozen,.25,'frozen','test-numpy','test-pillow')
        for values in [(.2,'frozen','test-numpy','test-pillow'),(.25,'changed','test-numpy','test-pillow'),(.25,'frozen','new-numpy','test-pillow')]:
            with self.assertRaises(ValueError):bench.check_acceptance_selection(frozen,*values)


if __name__=='__main__':unittest.main()
