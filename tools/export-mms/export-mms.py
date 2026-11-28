#!/usr/bin/env python3
# Export Meta's MMS-1B-all with one language adapter baked in, as a quantized
# ONNX graph — the first sub-step of Run 9 ("Next: Run 9" in
# ios-android-mirror-plan.md), which an agent must not invent unasked.
#
# Why per-language graphs: the transformers.js export (Xenova/mms-1b-all) has
# the English adapter baked into its graph — on 2026-11-25 all 144 named
# adapter tensors in it were shown byte-identical to Meta's adapter.eng — and
# transformers.js cannot load adapters. Lingala and French therefore need
# their own exports, produced from the pinned adapters in
# android/models/third_party/mms-1b-all/adapters/.
#
#   python3 export-mms.py --lang lin                 # export + quantize + parity
#   python3 export-mms.py --lang eng --xenova-check  # also compare against the
#                                                    # existing transformers.js export
#   python3 export-mms.py --lid                      # the language-ID model instead
#   python3 export-mms.py --lid --requantize         # rebuild lid-126/q8 from the pinned fp32
#   python3 export-mms.py --swap                     # one ASR graph, adapters as inputs
#
# --swap (owner, 2026-11-27) exports MMS-1B-all once, with the 290 tensors of
# an adapter file (48 layers x 6 adapter tensors, plus lm_head.weight and
# lm_head.bias) as graph inputs named exactly as in adapter.<lang>.safetensors,
# and the vocabulary dimension dynamic. An app keeps one graph and swaps a
# ~10 MB adapter in, instead of one 3.86 GB (fp32) or ~1 GB (q8) graph per
# language. Parity: against each onnx-<lang>/ fp32 graph on all 9 clips, and
# the q8 copy against each onnx-<lang>/q8 copy. It writes onnx-swap/ and
# parity-swap.json.
#
# Each run writes android/models/third_party/mms-1b-all/onnx-<lang>/ with the
# q8 graph, its config/tokenizer files, SHA256SUMS, SOURCE.txt and a parity
# report.
#
# --lid (Run 9 Step 1) exports facebook/mms-lid-126, Meta's language ID over
# 126 languages (lin, fra and eng among them), by the same recipe: eager
# attention, opset 11, the fp32 graph as the reference and a q8 copy for the
# size tables. Its parity runs on the first 3 s of each of the 9 fixture clips,
# the window the app's language ID reads (Run 9, Decision 6). It writes
# lid-126/ and parity-lid.json. The ASR path above is unchanged by it.
#
# There is no publisher checksum for a locally produced graph: the
# pin is the recipe — requirements.txt (exact versions of the environment
# that produced the exports), this script, and the pinned facebook revision —
# plus the recorded hashes. Record that plainly wherever the results land.

import argparse
import gc
import hashlib
import json
import platform
import shutil
import sys
import wave
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

REPO = 'facebook/mms-1b-all'
REV = '3d33597edbdaaba14a8e858e2c8caa76e3cec0cd'
LANGS = ('lin', 'fra', 'eng')
OPSET = 11  # the opset of the reference transformers.js export

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'android' / 'models' / 'third_party' / 'mms-1b-all'
CACHE = BASE / 'hf-cache'
XENOVA_Q8 = BASE / 'onnx' / 'onnx' / 'model_quantized.onnx'
FIXTURES = ROOT / 'tests' / 'fixtures' / 'speech'
ALL_CLIPS = ['date', 'phone', 'routing', 'silence', 'ssn-digits', 'ssn-grouped',
             'ssn-paused', 'text-hospital', 'yes']

# --lid: the language-ID model, its pinned revision, and the window it reads.
LID_REPO = 'facebook/mms-lid-126'
LID_REV = '53da6e311f3ce48f324fe335924216187e3109a4'
LID_WINDOW = 48000  # the first 3 s at 16 kHz, or the whole clip if shorter
LID_DIR = 'lid-126'

# --swap: one ASR graph for every language, the adapter tensors fed as inputs.
SWAP_DIR = 'onnx-swap'


def read_wav(path):
    """16 kHz mono PCM -> float32 in [-1, 1], the Transcriber port's contract."""
    with wave.open(str(path), 'rb') as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1, path
        raw = w.readframes(w.getnframes())
        width = w.getsampwidth()
    if width == 2:
        pcm = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    elif width == 4:
        pcm = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f'{path}: unsupported sample width {width}')
    return pcm


def greedy(logits):
    """Argmax ids per frame, collapsed: repeats merge, blank (0) drops."""
    ids = np.argmax(logits, axis=-1)
    out, prev = [], None
    for i in ids:
        if i != prev and i != 0:
            out.append(int(i))
        prev = i
    return out


def maxdiff(a, b):
    return float(np.max(np.abs(np.asarray(a) - np.asarray(b))))


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 22), b''):
            h.update(chunk)
    return h.hexdigest()


def versions():
    import importlib.metadata as im

    return {
        'python': platform.python_version(),
        'torch': im.version('torch'),
        'transformers': im.version('transformers'),
        'optimum': im.version('optimum'),
        'onnx': im.version('onnx'),
        'onnxruntime': im.version('onnxruntime'),
        'platform': platform.platform(),
    }


def main():
    ap = argparse.ArgumentParser()
    # Exactly one of --lang (an ASR export) and --lid (the language-ID export).
    mode = ap.add_mutually_exclusive_group(required=True)
    mode.add_argument('--lang', choices=LANGS)
    mode.add_argument('--lid', action='store_true',
                      help=f'export the language-ID model {LID_REPO} instead '
                           f'(parity on all 9 clips, first 3 s of each)')
    mode.add_argument('--swap', action='store_true',
                      help='export one ASR graph whose adapter tensors are inputs, '
                           f'into {SWAP_DIR}/ (parity against each onnx-<lang>/ graph)')
    ap.add_argument('--clips', default='3',
                    help='how many fixture clips for parity (3 or 9); ASR only, --lid uses all 9')
    ap.add_argument('--xenova-check', action='store_true',
                    help='eng: also compare against the existing transformers.js q8 export')
    ap.add_argument('--requantize', action='store_true',
                    help='--lid only: rebuild lid-126/q8 from the pinned fp32 graph, '
                         'without re-exporting it')
    args = ap.parse_args()
    if args.requantize and not args.lid:
        ap.error('--requantize applies to --lid only')
    if args.swap:
        if args.xenova_check:
            ap.error('--xenova-check does not apply to --swap')
        return main_swap()
    if args.lid:
        if args.xenova_check:
            ap.error('--xenova-check is an eng ASR check; it does not apply to --lid')
        return requantize_lid() if args.requantize else main_lid()
    lang = args.lang
    clips = ALL_CLIPS if (args.clips == '9' or args.xenova_check) else ALL_CLIPS[:3]

    import torch
    from transformers import AutoProcessor, Wav2Vec2ForCTC

    started = datetime.now(timezone.utc).isoformat(timespec='seconds')
    print(f'== MMS-1B-all export: lang={lang} clips={len(clips)} started {started}')

    # 1. The pinned PyTorch reference, adapter loaded from the pinned revision.
    #    Eager attention, not SDPA: SDPA needs opset >= 14 and the reference
    #    transformers.js export is opset 11 (eager is also what it was built with).
    torch_model = Wav2Vec2ForCTC.from_pretrained(
        REPO, revision=REV, target_lang=lang, cache_dir=str(CACHE),
        attn_implementation='eager',
        # The base checkpoint's lm_head is English-sized; the adapter replaces
        # it with the language's own vocabulary, so the base mismatch is
        # expected for every language whose vocab differs from eng.
        ignore_mismatched_sizes=True)
    torch_model.eval()
    processor = AutoProcessor.from_pretrained(
        REPO, revision=REV, target_lang=lang, cache_dir=str(CACHE))
    print(f'adapter loaded: {getattr(torch_model.config, "adapter_attn_dim", None) = }')

    features = {}
    for clip in clips:
        pcm = read_wav(FIXTURES / f'{clip}.wav')
        features[clip] = processor(pcm, sampling_rate=16000,
                                   return_tensors='pt').input_values

    # 2. The PyTorch reference logits, recorded before anything else moves.
    torch_logits = {}
    with torch.no_grad():
        for clip in clips:
            torch_logits[clip] = torch_model(features[clip]).logits[0].numpy()
    torch_ids = {clip: greedy(l) for clip, l in torch_logits.items()}
    print(f'torch reference done on {len(clips)} clips')

    # 3. Save the adapter-loaded model once, and export that copy, so the
    #    exported graph is exactly the weights the parity numbers cover.
    export_tmp = BASE / f'tmp-export-{lang}'
    model_dir = export_tmp / 'model'
    fp32_dir = export_tmp / 'fp32'
    torch_model.save_pretrained(str(model_dir))
    processor.save_pretrained(str(model_dir))
    # save_pretrained does not persist the attention choice; make the reload
    # inside main_export use eager too.
    cfg = json.loads((model_dir / 'config.json').read_text())
    cfg['_attn_implementation'] = 'eager'
    (model_dir / 'config.json').write_text(json.dumps(cfg, indent=2) + '\n')
    del torch_model
    gc.collect()

    from optimum.exporters.onnx import main_export
    main_export(str(model_dir), output=str(fp32_dir),
                task='automatic-speech-recognition', opset=OPSET, device='cpu')
    print(f'fp32 export done at opset {OPSET}')

    # 4. Parity of the fp32 graph against the recorded reference logits.
    from optimum.onnxruntime import ORTModelForCTC
    ort_model = ORTModelForCTC.from_pretrained(str(fp32_dir))

    ort32 = {}
    for clip in clips:
        ort32[clip] = ort_model(input_values=features[clip]).logits[0]

    fp32_report = {}
    for clip in clips:
        same = bool(np.array_equal(np.argmax(ort32[clip], axis=-1),
                                   np.argmax(torch_logits[clip], axis=-1)))
        fp32_report[clip] = {'max_abs_diff_vs_torch': maxdiff(ort32[clip], torch_logits[clip]),
                             'greedy_ids_equal_torch': same}
        print(f"fp32 vs torch {clip}: max|Δ|={fp32_report[clip]['max_abs_diff_vs_torch']:.3e} "
              f"greedy equal={same}")

    # 5. Quantize to q8 the way the transformers.js export was (dynamic,
    #    per-channel) but leave the 8 Conv nodes fp32: with them quantized the
    #    graph needs ConvInteger, which ORT 1.22.0 on macOS arm64 refuses to
    #    run ("Could not find an implementation for ConvInteger(10)") even
    #    though the transformers.js export contains the same nodes — its
    #    conv weights were quantized differently. The convs are ~14 MB of a
    #    ~973 MB pack. optimum 1.27 does the quantization through the
    #    standalone quantizer, not a model method.
    from optimum.onnxruntime import ORTQuantizer
    from optimum.onnxruntime.configuration import QuantizationConfig
    from onnxruntime.quantization import QuantFormat, QuantizationMode
    import onnx as onnxlib
    # Quantizing lm_head (the logits projection) or the 16-dim adapter
    # bottlenecks wrecks the outputs (max|Δ| ~5 on logits), and the Convs must
    # stay fp32 to avoid ConvInteger (see below). Build the exclusion list from
    # the exported graph itself so it cannot drift from the model.
    graph = onnxlib.load(str(fp32_dir / 'model.onnx'),
                         load_external_data=False).graph
    conv_nodes = [n.name for n in graph.node if n.op_type == 'Conv']
    adapter_nodes = [n.name for n in graph.node
                     if n.op_type == 'MatMul' and 'adapter_layer' in n.name]
    lm_head_nodes = [n.name for n in graph.node
                     if n.op_type == 'MatMul' and 'lm_head' in n.name]
    print(f'leaving fp32: {len(conv_nodes)} conv, {len(adapter_nodes)} adapter, '
          f'{len(lm_head_nodes)} lm_head matmuls')
    # reduce_range=True halved the int8 precision and wrecked the logits
    # (max|Δ| ~5 vs fp32, greedy ids diverging on every clip), so full-range.
    qconfig = QuantizationConfig(
        is_static=False, format=QuantFormat.QOperator, mode=QuantizationMode.IntegerOps,
        per_channel=True, reduce_range=False, operators_to_quantize=['MatMul'],
        nodes_to_exclude=conv_nodes + adapter_nodes + lm_head_nodes)
    del ort_model
    gc.collect()

    out_dir = BASE / f'onnx-{lang}'
    q8_dir = out_dir / 'q8'
    quantizer = ORTQuantizer.from_pretrained(str(fp32_dir))
    quantizer.quantize(save_dir=str(q8_dir), quantization_config=qconfig)
    # optimum names the output itself; normalise to the transformers.js name.
    produced = [p for p in q8_dir.glob('*.onnx') if p.name != 'model_quantized.onnx']
    if produced:
        produced[0].rename(q8_dir / 'model_quantized.onnx')
        print(f"renamed {produced[0].name} -> model_quantized.onnx")

    # The fp32 graph is the pinned reference: its greedy ids equal the PyTorch
    # reference on every fixture, while dynamic int8 of this 48-layer model
    # measurably diverges (see q8_report below and the Xenova check — the
    # shipped transformers.js q8 export diverges on 6 of 9 clips too). The q8
    # copy is kept only for the size and memory tables.
    shutil.copy2(fp32_dir / 'model.onnx', out_dir / 'model.onnx')
    if (fp32_dir / 'model.onnx_data').exists():
        shutil.copy2(fp32_dir / 'model.onnx_data', out_dir / 'model.onnx_data')
    shutil.copy2(fp32_dir / 'config.json', out_dir / 'config.json')
    processor.save_pretrained(str(out_dir))

    # 6. Parity of the q8 copy against the fp32 logits just recorded.
    import onnxruntime as ort
    sess = ort.InferenceSession(str(q8_dir / 'model_quantized.onnx'),
                                providers=['CPUExecutionProvider'])
    q8_report = {}
    for clip in clips:
        q8_logits = sess.run(None, {'input_values': features[clip].numpy()})[0][0]
        q8_report[clip] = {
            'max_abs_diff_vs_fp32': maxdiff(q8_logits, ort32[clip]),
            'greedy_ids_equal_fp32':
                bool(np.array_equal(np.argmax(q8_logits, axis=-1), np.argmax(ort32[clip], axis=-1))),
            'greedy_ids_equal_torch':
                bool(np.array_equal(np.argmax(q8_logits, axis=-1), np.argmax(torch_logits[clip], axis=-1))),
        }
        print(f"q8 {clip}: max|Δ| vs fp32={q8_report[clip]['max_abs_diff_vs_fp32']:.3e} "
              f"greedy equal fp32={q8_report[clip]['greedy_ids_equal_fp32']} "
              f"torch={q8_report[clip]['greedy_ids_equal_torch']}")

    # 7. eng only: the same comparison against the existing transformers.js
    #    export, which is the one graph already proven to carry an adapter.
    xenova_report = None
    if args.xenova_check:
        assert lang == 'eng', '--xenova-check is an eng check'
        xs = ort.InferenceSession(str(XENOVA_Q8), providers=['CPUExecutionProvider'])
        xenova_report = {}
        for clip in ALL_CLIPS:
            if clip not in features:
                pcm = read_wav(FIXTURES / f'{clip}.wav')
                features[clip] = processor(pcm, sampling_rate=16000,
                                           return_tensors='pt').input_values
            x_ids = greedy(xs.run(None, {'input_values': features[clip].numpy()})[0][0])
            ours = greedy(sess.run(None, {'input_values': features[clip].numpy()})[0][0]) \
                if clip in clips else None
            xenova_report[clip] = {
                'greedy_ids_equal_torch': x_ids == torch_ids[clip],
                'greedy_ids_equal_ours': (ours == x_ids) if ours is not None else None,
            }
        for clip, r in xenova_report.items():
            print(f"xenova {clip}: greedy equal torch={r['greedy_ids_equal_torch']} "
                  f"ours={r['greedy_ids_equal_ours']}")

    # 8. Pins and the parity report.
    lines = []
    for p in sorted(out_dir.rglob('*')):
        if p.is_file() and p.name != 'SHA256SUMS':
            lines.append(f'{sha256_file(p)}  {p.relative_to(out_dir).as_posix()}')
    (out_dir / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')
    (out_dir / 'SOURCE.txt').write_text(
        f'{REPO} (adapter {lang})\nrevision {REV}\n'
        f'produced locally by tools/export-mms/export-mms.py; no publisher checksum.\n'
        f'The pin is the recipe: requirements.txt + this script + the pinned revision.\n'
        f'Roles: model.onnx(+model.onnx_data) is the pinned fp32 reference — its greedy\n'
        f'ids equal the PyTorch reference on the fixture clips (parity-{lang}.json).\n'
        f'q8/model_quantized.onnx is a size experiment only: dynamic int8 of this\n'
        f'48-layer model diverges from the reference; never use it for goldens.\n')

    report = {
        'lang': lang, 'repo': REPO, 'revision': REV, 'opset': OPSET, 'started': started,
        'finished': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'versions': versions(), 'clips': clips,
        'fp32_vs_torch': fp32_report, 'q8_vs_fp32': q8_report,
        'xenova_check': xenova_report,
    }
    report_path = BASE / f'parity-{lang}.json'
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    shutil.rmtree(export_tmp, ignore_errors=True)
    print(f'== wrote {out_dir}')
    print(f'== wrote {report_path}')


def main_lid():
    """--lid: export facebook/mms-lid-126 by the ASR recipe above, step for step.

    The differences are only what a classifier needs: the model class and the
    optimum task, a 3 s window, the argmax label in place of the greedy ids,
    and the head (projector, classifier) in place of lm_head among the nodes
    left fp32.
    """
    clips = ALL_CLIPS

    import torch
    from transformers import AutoFeatureExtractor, Wav2Vec2ForSequenceClassification

    started = datetime.now(timezone.utc).isoformat(timespec='seconds')
    print(f'== MMS-LID-126 export: clips={len(clips)} window={LID_WINDOW} samples '
          f'started {started}')

    # 1. The pinned PyTorch reference. Eager attention, as in the ASR mode
    #    (SDPA needs opset >= 14). Every weight must come from the checkpoint:
    #    one left to random initialisation would make the export unrepeatable.
    torch_model, loading = Wav2Vec2ForSequenceClassification.from_pretrained(
        LID_REPO, revision=LID_REV, cache_dir=str(CACHE),
        attn_implementation='eager', output_loading_info=True)
    torch_model.eval()
    print(f"loading info: {len(loading['missing_keys'])} missing, "
          f"{len(loading['unexpected_keys'])} unexpected, "
          f"{len(loading['mismatched_keys'])} mismatched keys")
    assert not loading['missing_keys'] and not loading['mismatched_keys'], loading
    extractor = AutoFeatureExtractor.from_pretrained(
        LID_REPO, revision=LID_REV, cache_dir=str(CACHE))
    id2label = {int(i): name for i, name in torch_model.config.id2label.items()}
    label_ids = {lang: next(i for i, name in id2label.items() if name == lang)
                 for lang in LANGS}
    print(f'{len(id2label)} labels; ' +
          ', '.join(f'{lang}={i}' for lang, i in label_ids.items()))
    print(f'adapter_attn_dim = {getattr(torch_model.config, "adapter_attn_dim", None)}')

    # The window is cut before the feature extractor, so the normalisation
    # covers exactly the samples the model sees.
    features, samples = {}, {}
    for clip in clips:
        pcm = read_wav(FIXTURES / f'{clip}.wav')[:LID_WINDOW]
        samples[clip] = int(len(pcm))
        features[clip] = extractor(pcm, sampling_rate=16000,
                                   return_tensors='pt').input_values

    # 2. The PyTorch reference logits, recorded before anything else moves.
    torch_logits = {}
    with torch.no_grad():
        for clip in clips:
            torch_logits[clip] = torch_model(features[clip]).logits[0].numpy()
    torch_top = {clip: int(np.argmax(l)) for clip, l in torch_logits.items()}
    print(f'torch reference done on {len(clips)} clips: ' +
          ', '.join(f'{clip}={id2label[torch_top[clip]]}' for clip in clips))

    # 3. Save the loaded model once, and export that copy, so the exported
    #    graph is exactly the weights the parity numbers cover.
    export_tmp = BASE / 'tmp-export-lid'
    model_dir = export_tmp / 'model'
    fp32_dir = export_tmp / 'fp32'
    torch_model.save_pretrained(str(model_dir))
    extractor.save_pretrained(str(model_dir))
    # save_pretrained does not persist the attention choice; make the reload
    # inside main_export use eager too.
    cfg = json.loads((model_dir / 'config.json').read_text())
    cfg['_attn_implementation'] = 'eager'
    (model_dir / 'config.json').write_text(json.dumps(cfg, indent=2) + '\n')
    del torch_model
    gc.collect()

    from optimum.exporters.onnx import main_export
    main_export(str(model_dir), output=str(fp32_dir),
                task='audio-classification', opset=OPSET, device='cpu')
    print(f'fp32 export done at opset {OPSET}')

    # 4. Parity of the fp32 graph against the recorded reference logits, on a
    #    plain ORT session with the CPU provider, as the apps run it.
    import onnxruntime as ort
    sess32 = ort.InferenceSession(str(fp32_dir / 'model.onnx'),
                                  providers=['CPUExecutionProvider'])
    print(f'fp32 graph: inputs {[i.name for i in sess32.get_inputs()]} '
          f'outputs {[o.name for o in sess32.get_outputs()]}')
    ort32 = {}
    for clip in clips:
        ort32[clip] = sess32.run(['logits'], {'input_values': features[clip].numpy()})[0][0]
    fp32_top = {clip: int(np.argmax(ort32[clip])) for clip in clips}

    fp32_report = {}
    for clip in clips:
        same = fp32_top[clip] == torch_top[clip]
        fp32_report[clip] = {'max_abs_diff_vs_torch': maxdiff(ort32[clip], torch_logits[clip]),
                             'argmax_label_equal_torch': same}
        print(f"fp32 vs torch {clip}: max|Δ|={fp32_report[clip]['max_abs_diff_vs_torch']:.3e} "
              f"label torch={id2label[torch_top[clip]]} fp32={id2label[fp32_top[clip]]} "
              f"equal={same}")
    del sess32
    gc.collect()

    # 5. Quantize to q8 (lid_quantize below).
    out_dir = BASE / LID_DIR
    q8_dir = out_dir / 'q8'
    conv_nodes, adapter_nodes, head_nodes, head_exclude, q8_op_counts = \
        lid_quantize(fp32_dir, q8_dir)

    # The fp32 graph is the pinned reference; the q8 copy is kept only for the
    # size and memory tables.
    shutil.copy2(fp32_dir / 'model.onnx', out_dir / 'model.onnx')
    if (fp32_dir / 'model.onnx_data').exists():
        shutil.copy2(fp32_dir / 'model.onnx_data', out_dir / 'model.onnx_data')
    shutil.copy2(fp32_dir / 'config.json', out_dir / 'config.json')
    extractor.save_pretrained(str(out_dir))

    # 6. Parity of the q8 copy against the fp32 logits just recorded.
    sess = ort.InferenceSession(str(q8_dir / 'model_quantized.onnx'),
                                providers=['CPUExecutionProvider'])
    q8_report, q8_top = {}, {}
    for clip in clips:
        q8_logits = sess.run(['logits'], {'input_values': features[clip].numpy()})[0][0]
        q8_top[clip] = int(np.argmax(q8_logits))
        q8_report[clip] = {
            'max_abs_diff_vs_fp32': maxdiff(q8_logits, ort32[clip]),
            'argmax_label_equal_fp32': q8_top[clip] == fp32_top[clip],
            'argmax_label_equal_torch': q8_top[clip] == torch_top[clip],
        }
        print(f"q8 {clip}: max|Δ| vs fp32={q8_report[clip]['max_abs_diff_vs_fp32']:.3e} "
              f"label q8={id2label[q8_top[clip]]} "
              f"equal fp32={q8_report[clip]['argmax_label_equal_fp32']} "
              f"torch={q8_report[clip]['argmax_label_equal_torch']}")
    del sess
    gc.collect()

    # 7. Pins and the parity report.
    lines = []
    for p in sorted(out_dir.rglob('*')):
        if p.is_file() and p.name != 'SHA256SUMS':
            lines.append(f'{sha256_file(p)}  {p.relative_to(out_dir).as_posix()}')
    (out_dir / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')
    agree = sum(fp32_top[clip] == torch_top[clip] for clip in clips)
    (out_dir / 'SOURCE.txt').write_text(lid_source_text(len(id2label), agree, len(clips)))

    report = {
        'lang': 'lid', 'repo': LID_REPO, 'revision': LID_REV, 'opset': OPSET, 'started': started,
        'finished': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'versions': versions(), 'clips': clips,
        'fp32_vs_torch': fp32_report, 'q8_vs_fp32': q8_report,
        'xenova_check': None,
        'window_samples': LID_WINDOW, 'samples': samples,
        'num_labels': len(id2label), 'label_ids': label_ids,
        'argmax_labels': {clip: {'torch': id2label[torch_top[clip]],
                                 'fp32': id2label[fp32_top[clip]],
                                 'q8': id2label[q8_top[clip]]} for clip in clips},
        'nodes_left_fp32': {'conv': len(conv_nodes), 'adapter': 0,
                            'head': head_nodes, 'head_excluded_as': head_exclude},
        'adapter_matmuls_quantized': len(adapter_nodes),
        'q8_op_counts': q8_op_counts,
    }
    report_path = BASE / 'parity-lid.json'
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    shutil.rmtree(export_tmp, ignore_errors=True)
    print(f'== wrote {out_dir}')
    print(f'== wrote {report_path}')


def main_swap():
    """--swap: one MMS-1B-all ASR graph with the adapter tensors as inputs."""
    import torch
    import onnx as onnxlib
    import onnxruntime as ort
    from safetensors.numpy import load_file
    from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC

    clips = ALL_CLIPS
    started = datetime.now(timezone.utc).isoformat(timespec='seconds')
    print(f'== MMS-1B-all swap export: clips={len(clips)} started {started}')

    # 0. The pinned adapters, checked against adapters/SHA256SUMS first.
    adapter_dir = BASE / 'adapters'
    pins = dict(reversed(line.split('  ', 1))
                for line in (adapter_dir / 'SHA256SUMS').read_text().splitlines() if line)
    adapters = {}
    for lang in LANGS:
        name = f'adapter.{lang}.safetensors'
        got = sha256_file(adapter_dir / name)
        assert got == pins[name], f'{name}: {got} is not the pinned {pins[name]}'
        adapters[lang] = load_file(str(adapter_dir / name))
        print(f'pinned adapter OK: {name}, {len(adapters[lang])} tensors')
    names = sorted(adapters['lin'])
    for lang in LANGS:
        assert sorted(adapters[lang]) == names, f'{lang}: adapter tensor names differ from lin'
        assert all(a.dtype == np.float32 for a in adapters[lang].values()), f'{lang}: not float32'
    vocab = {lang: int(adapters[lang]['lm_head.weight'].shape[0]) for lang in LANGS}
    print(f'{len(names)} adapter tensors per language; vocabulary sizes {vocab}')

    # 1. The base model at the pinned revision, with no target_lang: every one
    #    of the 290 adapter parameters is replaced by a graph input below, so
    #    the checkpoint's own (English) adapter does not reach the graph. Not
    #    target_lang: transformers' load_adapter fetches adapter.<lang> from the
    #    repository's main branch, not from the pinned revision (seen
    #    2026-11-27); the pinned files in adapters/ are what this mode feeds.
    model = Wav2Vec2ForCTC.from_pretrained(
        REPO, revision=REV, cache_dir=str(CACHE), attn_implementation='eager')
    model.eval()
    params = dict(model.named_parameters())
    missing = [n for n in names if n not in params]
    assert not missing, f'adapter tensors with no model parameter: {missing[:3]}'
    for n in names:
        if not n.startswith('lm_head.'):  # lm_head's first dimension is the vocabulary
            assert tuple(params[n].shape) == adapters['lin'][n].shape, f'{n}: shape differs'

    class Swappable(torch.nn.Module):
        """The model with its 290 adapter parameters removed; forward sets each
        from a graph input as a plain tensor attribute, which nn.Linear and
        nn.LayerNorm read as self.weight and self.bias. (torch.func's
        functional_call cannot be traced: "The stateless API can't be used
        with Jitted modules", torch 2.8.0.)"""

        def __init__(self, inner, tensor_names):
            super().__init__()
            self.inner = inner
            self.tensor_names = tensor_names
            self.slots = []
            for name in tensor_names:
                path, attr = name.rsplit('.', 1)
                module = inner.get_submodule(path)
                del module._parameters[attr]
                self.slots.append((module, attr))

        def forward(self, input_values, *tensors):
            for (module, attr), tensor in zip(self.slots, tensors):
                setattr(module, attr, tensor)
            return self.inner(input_values).logits

    wrapper = Swappable(model, names).eval()

    extractor = Wav2Vec2FeatureExtractor.from_pretrained(str(BASE / 'onnx-lin'))
    features = {}
    for clip in clips:
        pcm = read_wav(FIXTURES / f'{clip}.wav')
        features[clip] = extractor(pcm, sampling_rate=16000, return_tensors='np').input_values

    # 2. The export: TorchScript exporter, opset 11 and eager attention, as
    #    optimum exported the per-language graphs.
    out_dir = BASE / SWAP_DIR
    export_tmp = BASE / 'tmp-export-swap'
    shutil.rmtree(export_tmp, ignore_errors=True)
    export_tmp.mkdir(parents=True)
    dummy = (torch.from_numpy(features['yes']),
             *[torch.from_numpy(adapters['lin'][n]) for n in names])
    dynamic = {'input_values': {0: 'batch_size', 1: 'sequence_length'},
               'lm_head.weight': {0: 'vocab_size'}, 'lm_head.bias': {0: 'vocab_size'},
               'logits': {0: 'batch_size', 1: 'frames', 2: 'vocab_size'}}
    with torch.no_grad():
        torch.onnx.export(wrapper, dummy, str(export_tmp / 'model.onnx'),
                          input_names=['input_values'] + names, output_names=['logits'],
                          dynamic_axes=dynamic, opset_version=OPSET,
                          do_constant_folding=True, dynamo=False)
    print(f'fp32 export done at opset {OPSET}')
    config = model.config.to_dict()
    del wrapper, model, params, dummy
    gc.collect()

    # One external-data file, as the per-language graphs have.
    out_dir.mkdir(exist_ok=True)
    proto = onnxlib.load(str(export_tmp / 'model.onnx'), load_external_data=True)
    graph_inputs = [i.name for i in proto.graph.input]
    assert graph_inputs == ['input_values'] + names, \
        f'graph inputs are not input_values + the adapter tensors: {graph_inputs[:4]}...'
    onnxlib.save(proto, str(out_dir / 'model.onnx'), save_as_external_data=True,
                 all_tensors_to_one_file=True, location='model.onnx_data', size_threshold=1024)
    del proto
    gc.collect()
    shutil.rmtree(export_tmp, ignore_errors=True)
    config.pop('vocab_size', None)
    (out_dir / 'config.json').write_text(json.dumps(config, indent=2, sort_keys=True) + '\n')
    extractor.save_pretrained(str(out_dir))
    (out_dir / 'adapter_inputs.json').write_text(json.dumps({
        'graph_inputs': ['input_values'] + names,
        'adapter_files': {lang: f'adapters/adapter.{lang}.safetensors' for lang in LANGS},
        'vocab_size': vocab,
        'tokenizers': {lang: f'onnx-{lang}/' for lang in LANGS},
    }, indent=2) + '\n')

    # 3. fp32 parity: the swap graph with each adapter fed in, against that
    #    language's own pinned fp32 graph. One session at a time.
    def feeds(lang, clip):
        f = {'input_values': features[clip]}
        f.update(adapters[lang])
        return f

    sess = ort.InferenceSession(str(out_dir / 'model.onnx'), providers=['CPUExecutionProvider'])
    swap32 = {(lang, clip): sess.run(['logits'], feeds(lang, clip))[0][0]
              for lang in LANGS for clip in clips}
    del sess
    gc.collect()
    fp32_report = {}
    for lang in LANGS:
        ref = ort.InferenceSession(str(BASE / f'onnx-{lang}' / 'model.onnx'),
                                   providers=['CPUExecutionProvider'])
        for clip in clips:
            want = ref.run(None, {'input_values': features[clip]})[0][0]
            got = swap32[(lang, clip)]
            r = {'max_abs_diff': maxdiff(got, want),
                 'bit_identical': bool(np.array_equal(got, want)),
                 'greedy_ids_equal': greedy(got) == greedy(want)}
            fp32_report[f'{lang}.{clip}'] = r
            print(f"fp32 swap vs onnx-{lang} {clip}: max|Δ|={r['max_abs_diff']:.3e} "
                  f"bit-identical={r['bit_identical']} greedy equal={r['greedy_ids_equal']}")
        del ref
        gc.collect()

    # 4. q8 by the ASR recipe: the Convs, the adapter MatMuls (now on graph
    #    inputs) and lm_head stay fp32.
    from optimum.onnxruntime import ORTQuantizer
    from optimum.onnxruntime.configuration import QuantizationConfig
    from onnxruntime.quantization import QuantFormat, QuantizationMode
    graph = onnxlib.load(str(out_dir / 'model.onnx'), load_external_data=False).graph
    conv_nodes = [n.name for n in graph.node if n.op_type == 'Conv']
    adapter_nodes = [n.name for n in graph.node
                     if n.op_type in ('MatMul', 'Gemm') and 'adapter_layer' in n.name]
    lm_head_nodes = [n.name for n in graph.node
                     if n.op_type in ('MatMul', 'Gemm') and 'lm_head' in n.name]
    matmuls = sum(1 for n in graph.node if n.op_type == 'MatMul')
    print(f'leaving fp32: {len(conv_nodes)} conv, {len(adapter_nodes)} adapter, '
          f'{len(lm_head_nodes)} lm_head nodes, of {matmuls} MatMul nodes')
    assert adapter_nodes and lm_head_nodes, 'adapter or lm_head nodes not found by name'
    del graph
    qconfig = QuantizationConfig(
        is_static=False, format=QuantFormat.QOperator, mode=QuantizationMode.IntegerOps,
        per_channel=True, reduce_range=False, operators_to_quantize=['MatMul'],
        nodes_to_exclude=conv_nodes + adapter_nodes + lm_head_nodes)
    q8_dir = out_dir / 'q8'
    quantizer = ORTQuantizer.from_pretrained(str(out_dir), file_name='model.onnx')
    quantizer.quantize(save_dir=str(q8_dir), quantization_config=qconfig)
    produced = [p for p in q8_dir.glob('*.onnx') if p.name != 'model_quantized.onnx']
    if produced:
        produced[0].rename(q8_dir / 'model_quantized.onnx')
        print(f'renamed {produced[0].name} -> model_quantized.onnx')
    del quantizer
    gc.collect()

    # 5. q8 parity: against the fp32 swap graph, and against each onnx-<lang>/q8.
    sess = ort.InferenceSession(str(q8_dir / 'model_quantized.onnx'),
                                providers=['CPUExecutionProvider'])
    swap8 = {(lang, clip): sess.run(['logits'], feeds(lang, clip))[0][0]
             for lang in LANGS for clip in clips}
    del sess
    gc.collect()
    q8_report = {}
    for lang in LANGS:
        ref = ort.InferenceSession(str(BASE / f'onnx-{lang}' / 'q8' / 'model_quantized.onnx'),
                                   providers=['CPUExecutionProvider'])
        for clip in clips:
            want = ref.run(None, {'input_values': features[clip]})[0][0]
            got = swap8[(lang, clip)]
            r = {'max_abs_diff_vs_lang_q8': maxdiff(got, want),
                 'bit_identical_lang_q8': bool(np.array_equal(got, want)),
                 'greedy_ids_equal_lang_q8': greedy(got) == greedy(want),
                 'greedy_ids_equal_swap_fp32': greedy(got) == greedy(swap32[(lang, clip)])}
            q8_report[f'{lang}.{clip}'] = r
            print(f"q8 swap vs onnx-{lang}/q8 {clip}: max|Δ|={r['max_abs_diff_vs_lang_q8']:.3e} "
                  f"bit-identical={r['bit_identical_lang_q8']} "
                  f"greedy equal={r['greedy_ids_equal_lang_q8']} "
                  f"vs swap fp32={r['greedy_ids_equal_swap_fp32']}")
        del ref
        gc.collect()

    # 6. Pins and the report.
    (out_dir / 'SOURCE.txt').write_text(
        f'{REPO}, every adapter as graph inputs\nrevision {REV}\n'
        f'produced locally by tools/export-mms/export-mms.py --swap; no publisher checksum.\n'
        f'The pin is the recipe: requirements.txt + this script + the pinned revision.\n'
        f'Inputs: input_values, then the 290 tensors of adapters/adapter.<lang>.safetensors\n'
        f'by name (adapter_inputs.json); logits are [batch, frames, vocab_size of the adapter].\n'
        f'model.onnx(+model.onnx_data) is fp32; q8/model_quantized.onnx is dynamic int8 of the\n'
        f'base MatMuls, with the Convs, adapter MatMuls and lm_head fp32 (the ASR recipe).\n'
        f'Parity against each onnx-<lang>/ graph is in parity-swap.json. The phone runs q8\n'
        f'(owner, 2026-11-27); never use q8 for goldens.\n')
    lines = []
    for p in sorted(out_dir.rglob('*')):
        if p.is_file() and p.name != 'SHA256SUMS':
            lines.append(f'{sha256_file(p)}  {p.relative_to(out_dir).as_posix()}')
    (out_dir / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')
    report = {
        'mode': 'swap', 'repo': REPO, 'revision': REV, 'opset': OPSET, 'started': started,
        'finished': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'versions': versions(), 'clips': clips, 'vocab_size': vocab,
        'adapter_tensors': len(names),
        'fp32_vs_lang_fp32': fp32_report, 'q8': q8_report,
        'nodes_left_fp32': {'conv': len(conv_nodes), 'adapter': len(adapter_nodes),
                            'lm_head': len(lm_head_nodes)},
    }
    report_path = BASE / 'parity-swap.json'
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(f'== wrote {out_dir}')
    print(f'== wrote {report_path}')


def lid_source_text(num_labels, agree, num_clips):
    return (
        f'{LID_REPO} (language ID, {num_labels} labels)\nrevision {LID_REV}\n'
        f'produced locally by tools/export-mms/export-mms.py --lid; no publisher checksum.\n'
        f'The pin is the recipe: requirements.txt + this script + the pinned revision.\n'
        f'Roles: model.onnx(+model.onnx_data) is the pinned fp32 reference — its argmax\n'
        f'label equals the PyTorch reference on {agree} of {num_clips} fixture clips, on the\n'
        f'first 3 s of each (parity-lid.json). q8/model_quantized.onnx is dynamic int8\n'
        f'of every MatMul except the head (projector, classifier), adapters included;\n'
        f'the Convs stay fp32. It is the graph a phone runs (owner, 2026-11-27); never\n'
        f'use it for goldens.\n')


def lid_quantize(fp32_dir, q8_dir):
    """Dynamic int8 of the LID graph in fp32_dir/model.onnx, written to q8_dir.

    The Convs stay fp32 (ConvInteger, see the ASR mode). So does the head
    (projector, then classifier after the mean pooling), which stands in for
    lm_head. The 16-dim adapter bottlenecks are quantized: Run 9 left them fp32,
    and the owner struck that on 2026-11-27. Returns the node lists and the q8
    op counts."""
    from collections import Counter
    from optimum.onnxruntime import ORTQuantizer
    from optimum.onnxruntime.configuration import QuantizationConfig
    from onnxruntime.quantization import QuantFormat, QuantizationMode
    import onnx as onnxlib
    graph = onnxlib.load(str(Path(fp32_dir) / 'model.onnx'),
                         load_external_data=False).graph
    conv_nodes = [n.name for n in graph.node if n.op_type == 'Conv']
    adapter_nodes = [n.name for n in graph.node
                     if n.op_type == 'MatMul' and 'adapter_layer' in n.name]
    head_nodes = [n.name for n in graph.node
                  if n.op_type in ('MatMul', 'Gemm')
                  and ('projector' in n.name or 'classifier' in n.name)]
    # The dynamic quantizer first rewrites every Gemm as MatMul + Add, naming
    # the MatMul '<gemm name>_MatMul' (onnxruntime 1.22.0,
    # quantization/onnx_quantizer.py:67-68 and onnx_model.py:403-408), and only
    # then matches nodes_to_exclude. The classifier is such a Gemm, so its
    # rewritten name is excluded too, or it would be quantized after all.
    head_exclude = head_nodes + [n.name + '_MatMul' for n in graph.node
                                 if n.op_type == 'Gemm' and n.name in head_nodes]
    matmuls = [n.name for n in graph.node if n.op_type == 'MatMul']
    excluded = set(conv_nodes + head_nodes)
    print(f'leaving fp32: {len(conv_nodes)} conv, {len(head_nodes)} head matmul/gemm '
          f'({", ".join(head_nodes)}; excluded as {", ".join(head_exclude)}); quantizing '
          f'{len(adapter_nodes)} adapter matmuls among '
          f'{sum(1 for m in matmuls if m not in excluded)} of {len(matmuls)} MatMul nodes')
    assert head_nodes, 'no projector or classifier MatMul/Gemm node found by name'
    assert adapter_nodes, 'no adapter_layer MatMul node found by name'
    qconfig = QuantizationConfig(
        is_static=False, format=QuantFormat.QOperator, mode=QuantizationMode.IntegerOps,
        per_channel=True, reduce_range=False, operators_to_quantize=['MatMul'],
        nodes_to_exclude=conv_nodes + head_exclude)

    quantizer = ORTQuantizer.from_pretrained(str(fp32_dir), file_name='model.onnx')
    quantizer.quantize(save_dir=str(q8_dir), quantization_config=qconfig)
    # optimum names the output itself; normalise to the transformers.js name.
    produced = [p for p in Path(q8_dir).glob('*.onnx') if p.name != 'model_quantized.onnx']
    if produced:
        produced[0].rename(Path(q8_dir) / 'model_quantized.onnx')
        print(f"renamed {produced[0].name} -> model_quantized.onnx")
    del quantizer
    gc.collect()

    # Check the result: every node meant to stay fp32 is still there, under its
    # name after the Gemm rewrite, as its fp32 op; no adapter MatMul is left.
    q8_graph = onnxlib.load(str(Path(q8_dir) / 'model_quantized.onnx'),
                            load_external_data=False).graph
    q8_ops = {n.name: n.op_type for n in q8_graph.node}
    q8_op_counts = dict(sorted(Counter(q8_ops.values()).items()))
    want_fp32 = {name: 'Conv' for name in conv_nodes}
    want_fp32.update({(n.name + '_MatMul' if n.op_type == 'Gemm' else n.name): 'MatMul'
                      for n in graph.node if n.name in head_nodes})
    wrong = [name for name, op in want_fp32.items() if q8_ops.get(name) != op]
    still_fp32 = [name for name in adapter_nodes if q8_ops.get(name) == 'MatMul']
    print(f"q8 graph: {q8_op_counts.get('MatMulInteger', 0)} MatMulInteger, "
          f"{q8_op_counts.get('MatMul', 0)} MatMul, {q8_op_counts.get('Gemm', 0)} Gemm, "
          f"{q8_op_counts.get('Conv', 0)} Conv, {q8_op_counts.get('ConvInteger', 0)} ConvInteger; "
          f"{len(want_fp32) - len(wrong)} of {len(want_fp32)} nodes meant to stay fp32 did; "
          f"{len(still_fp32)} adapter matmuls left fp32")
    assert not wrong, f'quantized although excluded: {wrong}'
    assert not still_fp32, f'adapter matmuls not quantized: {still_fp32[:3]}...'
    return conv_nodes, adapter_nodes, head_nodes, head_exclude, q8_op_counts


def requantize_lid():
    """--lid --requantize: rebuild lid-126/q8 from the pinned fp32 graph.

    The fp32 graph, its config files and its parity against PyTorch are not
    touched: the fp32 files are hashed against lid-126/SHA256SUMS first, and
    the PyTorch labels are read from the existing parity-lid.json. The old q8/
    is moved to superseded/lid-126-q8-adapters-fp32/, not deleted."""
    from transformers import AutoFeatureExtractor
    import onnxruntime as ort

    clips = ALL_CLIPS
    out_dir = BASE / LID_DIR
    started = datetime.now(timezone.utc).isoformat(timespec='seconds')
    print(f'== MMS-LID-126 requantize: {out_dir} started {started}')

    pins = {}
    for line in (out_dir / 'SHA256SUMS').read_text().splitlines():
        digest, name = line.split('  ', 1)
        pins[name] = digest
    for name in ('model.onnx', 'model.onnx_data', 'config.json', 'preprocessor_config.json'):
        got = sha256_file(out_dir / name)
        assert got == pins[name], f'{name}: {got} is not the pinned {pins[name]}'
        print(f'pinned fp32 file OK: {name}')

    old_report = json.loads((BASE / 'parity-lid.json').read_text())
    torch_labels = {clip: old_report['argmax_labels'][clip]['torch'] for clip in clips}
    cfg = json.loads((out_dir / 'config.json').read_text())
    id2label = {int(i): name for i, name in cfg['id2label'].items()}

    extractor = AutoFeatureExtractor.from_pretrained(str(out_dir))
    features = {}
    for clip in clips:
        pcm = read_wav(FIXTURES / f'{clip}.wav')[:LID_WINDOW]
        features[clip] = extractor(pcm, sampling_rate=16000, return_tensors='np').input_values

    sess32 = ort.InferenceSession(str(out_dir / 'model.onnx'), providers=['CPUExecutionProvider'])
    ort32 = {clip: sess32.run(['logits'], {'input_values': features[clip]})[0][0] for clip in clips}
    fp32_top = {clip: int(np.argmax(ort32[clip])) for clip in clips}
    for clip in clips:
        assert id2label[fp32_top[clip]] == old_report['argmax_labels'][clip]['fp32'], \
            f'{clip}: the pinned fp32 graph no longer gives its recorded label'
    print('fp32 labels equal the recorded ones on all clips')
    del sess32
    gc.collect()

    new_q8 = out_dir / 'q8.new'
    shutil.rmtree(new_q8, ignore_errors=True)
    conv_nodes, adapter_nodes, head_nodes, head_exclude, q8_op_counts = \
        lid_quantize(out_dir, new_q8)

    sess = ort.InferenceSession(str(new_q8 / 'model_quantized.onnx'),
                                providers=['CPUExecutionProvider'])
    q8_report, q8_top = {}, {}
    for clip in clips:
        q8_logits = sess.run(['logits'], {'input_values': features[clip]})[0][0]
        q8_top[clip] = int(np.argmax(q8_logits))
        q8_report[clip] = {
            'max_abs_diff_vs_fp32': maxdiff(q8_logits, ort32[clip]),
            'argmax_label_equal_fp32': q8_top[clip] == fp32_top[clip],
            'argmax_label_equal_torch': id2label[q8_top[clip]] == torch_labels[clip],
        }
        print(f"q8 {clip}: max|Δ| vs fp32={q8_report[clip]['max_abs_diff_vs_fp32']:.3e} "
              f"label q8={id2label[q8_top[clip]]} "
              f"equal fp32={q8_report[clip]['argmax_label_equal_fp32']} "
              f"torch={q8_report[clip]['argmax_label_equal_torch']}")
    del sess
    gc.collect()

    superseded = BASE / 'superseded' / 'lid-126-q8-adapters-fp32'
    superseded.parent.mkdir(exist_ok=True)
    assert not superseded.exists(), f'{superseded} exists; move it away first'
    (out_dir / 'q8').rename(superseded)
    new_q8.rename(out_dir / 'q8')
    print(f'moved the old q8/ to {superseded}')

    agree = sum(id2label[fp32_top[clip]] == torch_labels[clip] for clip in clips)
    (out_dir / 'SOURCE.txt').write_text(lid_source_text(len(id2label), agree, len(clips)))
    lines = []
    for p in sorted(out_dir.rglob('*')):
        if p.is_file() and p.name != 'SHA256SUMS':
            lines.append(f'{sha256_file(p)}  {p.relative_to(out_dir).as_posix()}')
    (out_dir / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')

    report = dict(old_report)
    report['superseded_q8'] = {
        'recipe': 'Run 9: Convs, the 96 adapter MatMuls and the head left fp32',
        'moved_to': str(superseded.relative_to(BASE)),
        'q8_vs_fp32': old_report['q8_vs_fp32'],
        'nodes_left_fp32': old_report.get('nodes_left_fp32'),
        'q8_op_counts': old_report.get('q8_op_counts'),
        'argmax_labels_q8': {c: old_report['argmax_labels'][c]['q8'] for c in clips},
    }
    report['requantized'] = {
        'started': started, 'finished': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'versions': versions(),
        'recipe': 'every MatMul except the head quantized, adapters included; Convs fp32 '
                  '(owner, 2026-11-27)',
    }
    report['q8_vs_fp32'] = q8_report
    report['nodes_left_fp32'] = {'conv': len(conv_nodes), 'adapter': 0,
                                 'head': head_nodes, 'head_excluded_as': head_exclude}
    report['adapter_matmuls_quantized'] = len(adapter_nodes)
    report['q8_op_counts'] = q8_op_counts
    for clip in clips:
        report['argmax_labels'][clip]['q8'] = id2label[q8_top[clip]]
    report_path = BASE / 'parity-lid.json'
    report_path.write_text(json.dumps(report, indent=2) + '\n')
    print(f'== wrote {out_dir}/q8, SHA256SUMS and SOURCE.txt')
    print(f'== wrote {report_path}')


if __name__ == '__main__':
    sys.exit(main())
