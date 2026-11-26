#!/usr/bin/env python3
"""The MMS reference golden (Run 9, Decision 2 in ios-android-mirror-plan.md).

What transformers 4.53.3 and onnxruntime 1.22.0 produce from the pinned fp32
MMS graphs, recorded so the `:models` module of the Android and iOS ports can
be checked against it:

- the features: Wav2Vec2FeatureExtractor, called as transformers' ASR pipeline
  calls it on one unpadded clip, for every fixture clip and for its first 3 s;
- the ASR output of the lin, fra and eng exports (onnx-lin/, onnx-fra/,
  onnx-eng/, each with its adapter baked in): per-frame argmax ids, the CTC
  collapse, the text Wav2Vec2CTCTokenizer decodes from them exactly as the
  pipeline does, and each frame's top-two logit gap;
- the language ID of facebook/mms-lid-126 (lid-126/), on the first 3 s;
- fixed id lists decoded by each language's tokenizer.

Decision 2: the golden comes from Python, under the export venv's interpreter.
transformers.js is not used: it cannot load adapters, and the exports have no
tokenizer.json. Every session is a plain onnxruntime.InferenceSession on the
fp32 graph (<folder>/model.onnx with model.onnx_data beside it), with the CPU
provider and default SessionOptions, as the Kotlin port runs it. The q8 copies
are never run here (Decision 1); their hashes are recorded so the device tests
can check what they load. The golden also cross-checks itself: for each
language, transformers' own automatic-speech-recognition pipeline over
optimum's ORTModelForCTC, on the same fp32 graph, must give the same text on
every clip.

  .venv/bin/python tools/golden/mms.py               write the golden
  .venv/bin/python tools/golden/mms.py --check       compare with the committed one
  .venv/bin/python tools/golden/mms.py --check FILE  compare with FILE

where .venv is android/models/third_party/mms-1b-all/.venv, run from the repo
root. It writes android/models/src/commonTest/resources/golden/mms.json.

Exit codes, as tools/golden/models.mjs:
  0  the golden was written, or the checked one is byte-for-byte fresh;
  1  the checked golden is stale or missing (the first differing key paths are
     printed);
  2  a package of tools/export-mms/requirements.txt is missing or at another
     version, an ASR graph folder is missing, or a pinned input (a graph file
     against android/models/mms.SHA256SUMS and its folder's SHA256SUMS, or a
     fixture WAV against android/models/speech-fixtures.SHA256SUMS) is missing
     or differs;
  3  the arguments were wrong, a generator assertion failed, or another error.

Before anything is loaded, every file the golden lists is stream-hashed against
its pins. Nothing here touches the network: the Hugging Face libraries are put
in offline mode before they are imported, and every file is read locally.

The golden depends on the CPU. A 1B-parameter fp32 graph run by ORT's CPU
kernels gives logits that can differ in the last bits on another CPU or
instruction set, and an argmax can then flip where two logits are close (the
gaps show where). So, like Run 8's Whisper token ids, --check is meaningful
only on the machine that wrote the golden (the owner's Mac). Run it when a
graph, the pinned runtime, or the reference's decoding changes, and commit
what it writes. The golden is generated, never edited by hand.

Memory: each fp32 graph is about 3.86 GB. The script holds one session at a
time and frees it (del + gc.collect()) before opening the next. Run no other
model process alongside it.
"""

import base64
import gc
import hashlib
import json
import os
import platform
import re
import resource
import statistics
import sys
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / 'android' / 'models' / 'third_party' / 'mms-1b-all'
PINS = ROOT / 'android' / 'models' / 'mms.SHA256SUMS'
FIXTURE_PINS = ROOT / 'android' / 'models' / 'speech-fixtures.SHA256SUMS'
FIXTURES = ROOT / 'tests' / 'fixtures' / 'speech'
REQUIREMENTS = ROOT / 'tools' / 'export-mms' / 'requirements.txt'
DEST = ROOT / 'android' / 'models' / 'src' / 'commonTest' / 'resources' / 'golden' / 'mms.json'
GENERATOR = 'tools/golden/mms.py'

CLIPS = ['date', 'phone', 'routing', 'silence', 'ssn-digits', 'ssn-grouped',
         'ssn-paused', 'text-hospital', 'yes']
# (graph key, folder, the app's language code, the tokenizer's target_lang)
ASR_GRAPHS = [('lin', 'onnx-lin', 'ln', 'lin'),
              ('fra', 'onnx-fra', 'fr', 'fra'),
              ('eng', 'onnx-eng', 'en', 'eng')]
LID_FOLDER = 'lid-126'
CANDIDATES = {'lin': 'ln', 'fra': 'fr', 'eng': 'en'}
SAMPLING_RATE = 16000
EPSILON = 1e-7               # zero_mean_unit_var_norm's constant
LID_WINDOW = 48000           # the first 3 s (Decision 6)
MAX_SAMPLES = 480000         # 30 s (Decision 7): longer clips are refused
FEATURE_CONFIG_KEYS = ['do_normalize', 'sampling_rate', 'feature_size', 'padding_value',
                       'return_attention_mask']
SESSION_PROVIDERS = ['CPUExecutionProvider']

USAGE = '\n'.join([
    'usage: android/models/third_party/mms-1b-all/.venv/bin/python tools/golden/mms.py'
    '                 write android/models/src/commonTest/resources/golden/mms.json',
    '       android/models/third_party/mms-1b-all/.venv/bin/python tools/golden/mms.py'
    ' --check [file]   compare (default: the committed golden)',
])


class GeneratorError(Exception):
    """A generator assertion: exit 3."""


class Missing(Exception):
    """A missing or wrong package, a missing graph folder, or a pin mismatch: exit 2."""


def log(msg=''):
    print(msg, flush=True)


def rel(path):
    """A path relative to the repo root, for messages; never an absolute path."""
    try:
        return Path(path).resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


# --- 1. Packages ------------------------------------------------------------

def check_packages():
    """Every `name==version` of requirements.txt must be installed at that version."""
    import importlib.metadata as im

    if not REQUIREMENTS.is_file():
        raise Missing(f'{rel(REQUIREMENTS)} is missing')
    wanted = {}
    for line in REQUIREMENTS.read_text(encoding='utf-8').splitlines():
        line = line.split('#', 1)[0].strip()
        if not line:
            continue
        m = re.fullmatch(r'([A-Za-z0-9_.\-]+)==([A-Za-z0-9_.+\-]+)', line)
        if not m:
            raise GeneratorError(f'{rel(REQUIREMENTS)} has a line this script cannot read: {line!r}')
        wanted[m.group(1)] = m.group(2)
    problems = []
    for name, version in wanted.items():
        try:
            have = im.version(name)
        except im.PackageNotFoundError:
            problems.append(f'{name} is not installed (want {version})')
            continue
        if have != version:
            problems.append(f'{name} is {have}, want {version}')
    if problems:
        raise Missing('the venv does not match tools/export-mms/requirements.txt: ' + '; '.join(problems) +
                      '. Run this script with android/models/third_party/mms-1b-all/.venv/bin/python; '
                      'recreate that venv with: python3.11 -m venv .venv && '
                      '.venv/bin/pip install -r tools/export-mms/requirements.txt')
    return {name: im.version(name) for name in
            ('numpy', 'torch', 'transformers', 'optimum', 'onnxruntime')}


# --- 2. Pins ----------------------------------------------------------------

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 22), b''):
            h.update(chunk)
    return h.hexdigest()


def read_sums(path, comments=False):
    """`<sha256>  <path>` lines, in file order, as a dict."""
    if not path.is_file():
        raise Missing(f'{rel(path)} is missing')
    out = {}
    for n, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip() or (comments and line.startswith('#')):
            continue
        m = re.fullmatch(r'([0-9a-f]{64})  (\S(?:.*\S)?)', line)
        if not m:
            raise Missing(f'{rel(path)}:{n} is not a "<sha256>  <path>" line: {line!r}')
        if m.group(2) in out:
            raise Missing(f'{rel(path)}:{n} lists {m.group(2)} twice')
        out[m.group(2)] = m.group(1)
    return out


def verify_folder(folder, pins):
    """The folder's own SHA256SUMS must equal its lines in mms.SHA256SUMS, and
    every file must hash to its pin. Returns the folder's SHA256SUMS as a map."""
    own = read_sums(BASE / folder / 'SHA256SUMS')
    pinned = {p[len(folder) + 1:]: h for p, h in pins.items() if p.startswith(folder + '/')}
    if own != pinned:
        only_own = sorted(set(own) - set(pinned))
        only_pinned = sorted(set(pinned) - set(own))
        differ = sorted(p for p in set(own) & set(pinned) if own[p] != pinned[p])
        raise Missing(f'{folder}/SHA256SUMS and android/models/mms.SHA256SUMS disagree: '
                      f'only in the folder {only_own}, only in mms.SHA256SUMS {only_pinned}, '
                      f'different hashes {differ}. Run: node tools/fetch-model.mjs --verify mms')
    total = 0
    for path, want in own.items():
        f = BASE / folder / path
        if not f.is_file():
            raise Missing(f'{folder}/{path} is missing. Run: node tools/fetch-model.mjs --verify mms')
        total += f.stat().st_size
        have = sha256_file(f)
        if have != want:
            raise Missing(f'{folder}/{path} is not the pinned file ({have}, pinned {want}). '
                          'Run: node tools/fetch-model.mjs --verify mms')
    return own, total


def read_wav(path, np):
    """16 kHz mono int16 PCM -> float32 in [-1, 1], as tools/export-mms/export-mms.py's
    read_wav does it (the Transcriber port's contract)."""
    with wave.open(str(path), 'rb') as w:
        if w.getframerate() != SAMPLING_RATE or w.getnchannels() != 1:
            raise GeneratorError(f'{rel(path)} is not 16 kHz mono')
        if w.getcomptype() != 'NONE':
            raise GeneratorError(f'{rel(path)} is compressed ({w.getcomptype()})')
        raw = w.readframes(w.getnframes())
        width = w.getsampwidth()
    if width != 2:
        raise GeneratorError(f'{rel(path)} has sample width {width}; the fixtures are int16')
    return np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0


# --- 3. Output helpers --------------------------------------------------------

def pack(values, np, dims=None):
    """A float32 array as base64 of its little-endian bytes, the packed-array
    object whisper.json uses."""
    a = np.asarray(values)
    if a.dtype != np.float32:
        raise GeneratorError(f'pack: {a.dtype}, not float32')
    dims = list(a.shape) if dims is None else dims
    if int(np.prod(dims)) != a.size:
        raise GeneratorError(f'pack: dims {dims} for {a.size} values')
    return {'dtype': 'float32', 'dims': [int(d) for d in dims], 'byteOrder': 'little-endian',
            'base64': base64.b64encode(a.astype('<f4').tobytes()).decode('ascii')}


def f32_sha(a, np):
    return hashlib.sha256(np.ascontiguousarray(a, dtype='<f4').tobytes()).hexdigest()


def diff_paths(a, b, path='', out=None, limit=10):
    """The JSON paths where two parsed trees differ, at most `limit` of them."""
    out = [] if out is None else out
    if len(out) >= limit:
        return out
    at = path or '(root)'
    if isinstance(a, dict) and isinstance(b, dict):
        for key in list(a) + [k for k in b if k not in a]:
            if len(out) >= limit:
                break
            nxt = f'{path}.{key}' if path else key
            if key not in a or key not in b:
                out.append(nxt)
            else:
                diff_paths(a[key], b[key], nxt, out, limit)
        if list(a) != list(b) and not out:
            out.append(f'{at} (key order)')
        return out
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append(f'{at} ({len(a)} vs {len(b)} entries)')
        for i in range(min(len(a), len(b))):
            if len(out) >= limit:
                break
            diff_paths(a[i], b[i], f'{path}[{i}]', out, limit)
        return out
    if type(a) is not type(b) or a != b:
        out.append(at)
    return out


# --- 4. Sources ---------------------------------------------------------------

class Sources:
    """`path:line what` for a rule, found in the installed package source.

    A rule is a run of consecutive lines, each containing its needle in order;
    it must occur exactly once (within `scope`, a top-level class, when given),
    or the generator fails rather than cite a line it has not seen."""

    def __init__(self, site):
        self.site = site
        self.cache = {}

    def lines(self, path):
        if path not in self.cache:
            self.cache[path] = (self.site / path).read_text(encoding='utf-8').splitlines()
        return self.cache[path]

    def find(self, path, needles, scope=None):
        lines = self.lines(path)
        needles = [needles] if isinstance(needles, str) else needles
        lo, hi = 0, len(lines)
        if scope is not None:
            starts = [i for i, line in enumerate(lines) if line.startswith(f'class {scope}(')]
            if len(starts) != 1:
                raise GeneratorError(f'{path}: {len(starts)} lines start "class {scope}("')
            lo = starts[0]
            hi = next((i for i in range(lo + 1, len(lines)) if lines[i].startswith('class ')),
                      len(lines))
        hits = [i for i in range(lo, hi - len(needles) + 1)
                if all(n in lines[i + k] for k, n in enumerate(needles))]
        if len(hits) != 1:
            raise GeneratorError(f'{path}: the rule {needles!r} occurs {len(hits)} times'
                                 f'{" in class " + scope if scope else ""}; expected once')
        return hits[0]

    def cite(self, path, needles, what, scope=None, at=0):
        return f'{path}:{self.find(path, needles, scope) + 1 + at} {what}'


def feature_sources(src):
    asr = 'transformers/pipelines/automatic_speech_recognition.py'
    fe = 'transformers/models/wav2vec2/feature_extraction_wav2vec2.py'
    seq = 'transformers/feature_extraction_sequence_utils.py'
    npm = 'numpy/_core/_methods.py'
    ac = 'transformers/pipelines/audio_classification.py'
    return [
        src.cite(asr, ['else:', 'processed = self.feature_extractor(', 'inputs,',
                       'sampling_rate=self.feature_extractor.sampling_rate,', 'return_tensors="pt",',
                       'return_attention_mask=True,', ')'],
                 'the ASR pipeline (CTC, no chunking) calls the extractor on the whole clip: '
                 'sampling_rate, return_tensors, return_attention_mask=True, no padding argument', at=1),
        src.cite(fe, 'if sampling_rate != self.sampling_rate:', 'the sampling rate must be 16000'),
        src.cite(fe, 'padding: Union[bool, str, PaddingStrategy] = False,',
                 'padding defaults to False (do not pad)'),
        src.cite(seq, 'if value.dtype is np.dtype(np.float64):',
                 'pad() casts only float64 (to float32); the float32 input is kept'),
        src.cite(fe, 'if self._get_padding_strategies(padding, max_length=max_length) is not '
                     'PaddingStrategy.DO_NOT_PAD',
                 'without padding the attention mask is not used: the whole clip is one vector'),
        src.cite(fe, 'normed_input_values = [(x - x.mean()) / np.sqrt(x.var() + 1e-7) for x in input_values]',
                 'normalization: (x - x.mean()) / np.sqrt(x.var() + 1e-7), on the float32 array '
                 '(1e-7 is a Python float, so under NEP 50 the sum stays float32)'),
        src.cite(npm, 'ret = umr_sum(arr, axis, dtype, out, keepdims, where=where)',
                 'mean: np.add.reduce of the float32 samples, dtype None (float32 pairwise summation)'),
        src.cite(npm, ['else:', 'ret = ret.dtype.type(ret / rcount)'],
                 'mean: the float32 sum divided by the intp count, then cast back with ret.dtype.type',
                 at=1),
        src.cite(npm, 'arrmean = um.true_divide(arrmean, div, out=arrmean,',
                 'var: its mean is the float32 keepdims sum, true_divide by the intp count into a '
                 'float32 out'),
        src.cite(npm, 'x = um.subtract(arr, arrmean, out=...)',
                 'var: x - mean in float32, then squared in place'),
        src.cite(npm, 'ret = umr_sum(x, axis, dtype, out, keepdims=keepdims, where=where)',
                 'var: np.add.reduce of the float32 squares'),
        src.cite(npm, ["elif hasattr(ret, 'dtype'):", 'ret = ret.dtype.type(ret / rcount)'],
                 'var: the sum of squares divided by the intp count (ddof 0), then cast back with '
                 'ret.dtype.type', at=1),
        src.cite(ac, ['processed = self.feature_extractor(',
                      'inputs, sampling_rate=self.feature_extractor.sampling_rate, return_tensors="pt"'],
                 'the audio-classification pipeline calls the extractor the same way on what it is given, '
                 'and passes the attention_mask on to the model; the exported LID graph takes '
                 'input_values only. The 3 s window is Run 9 Decision 6, not the pipeline\'s'),
    ]


def decoding_sources(src):
    asr = 'transformers/pipelines/automatic_speech_recognition.py'
    tok = 'transformers/models/wav2vec2/tokenization_wav2vec2.py'
    utils = 'transformers/tokenization_utils.py'
    base = 'transformers/tokenization_utils_base.py'
    ac = 'transformers/pipelines/audio_classification.py'
    ctc = 'Wav2Vec2CTCTokenizer'

    # clean_up_tokenization's replacements, read from the source itself.
    start = src.find(base, 'def clean_up_tokenization(out_string: str) -> str:')
    body = []
    for line in src.lines(base)[start + 1:]:
        if 'return out_string' in line:
            break
        body.append(line)
    pairs = re.findall(r'\.replace\(("[^"]*"), ("[^"]*")\)', '\n'.join(body))
    if len(pairs) < 4:
        raise GeneratorError(f'{base}: clean_up_tokenization has {len(pairs)} replacements')
    replacements = ', '.join(f'{a} -> {b}' for a, b in pairs)

    return [
        src.cite(asr, ['else:', 'self.type = "ctc"'],
                 'without a pyctcdecode decoder the pipeline type is "ctc" (no beam search, no LM)', at=1),
        src.cite(asr, 'out = {"tokens": logits.argmax(dim=-1)}',
                 'greedy: argmax per frame over the vocabulary (torch.argmax returns the first index '
                 'on ties, as np.argmax does)'),
        src.cite(asr, 'skip_special_tokens = self.type != "ctc"',
                 'CTC decodes with skip_special_tokens=False'),
        src.cite(asr, 'text = self.tokenizer.decode(items, skip_special_tokens=skip_special_tokens)',
                 'the per-frame ids go to tokenizer.decode whole, uncollapsed'),
        src.cite(tok, ['if target_lang is not None:', 'self.encoder = self.vocab[target_lang]'],
                 'the vocabulary is vocab.json[target_lang] (target_lang from tokenizer_config.json)',
                 scope=ctc, at=1),
        src.cite(utils, 'tokens.append(self._added_tokens_decoder[index].content)',
                 'ids of added tokens (<pad>, <s>, </s>, <unk>) decode to their content'),
        src.cite(tok, 'result = self.decoder.get(index, self.unk_token)',
                 'any other id decodes through the vocabulary; an id not in it becomes <unk>', scope=ctc),
        src.cite(tok, ['clean_up_tokenization_spaces: Optional[bool] = None,', 'group_tokens: bool = True,'],
                 '_decode groups tokens by default (the pipeline does not pass group_tokens)',
                 scope=ctc, at=1),
        src.cite(tok, 'chars, char_repetitions = zip(*((token, len(list(group_iter))) for token, '
                      'group_iter in groupby(tokens)))',
                 'repeats merge first (itertools.groupby over the token strings)', scope=ctc),
        src.cite(tok, 'processed_chars = list(filter(lambda char: char != self.pad_token, chars))',
                 'then the CTC blank <pad> (id 0) is dropped', scope=ctc),
        src.cite(tok, 'self.replace_word_delimiter_char if char == self.word_delimiter_token else char '
                      'for char in processed_chars',
                 'then each "|" becomes replace_word_delimiter_char (" ")', scope=ctc),
        src.cite(tok, 'string = join_char.join(processed_chars).strip()',
                 'then the tokens are joined with "" (spaces_between_special_tokens=False) and str.strip() '
                 'is applied', scope=ctc),
        src.cite(tok, ['if clean_up_tokenization_spaces:', 'text = self.clean_up_tokenization(text)'],
                 'then clean_up_tokenization, since tokenizer_config.json sets '
                 'clean_up_tokenization_spaces true', scope=ctc),
        src.cite(base, 'def clean_up_tokenization(out_string: str) -> str:',
                 f'clean_up_tokenization is str.replace in this order: {replacements}'),
        src.cite(ac, 'probs = model_outputs.logits[0].softmax(-1)',
                 'language ID: the audio-classification pipeline takes the softmax over all labels '
                 '(the golden computes it in float64 from the float32 logits, max subtracted)'),
    ]


# --- 5. Decode cases ----------------------------------------------------------

# (name, tokens, expected text or None). '<pad>' is the blank. A case whose
# tokens are not all in a language's vocabulary is left out for that language.
DECODE_CASES = [
    ('blank alone', ['<pad>'], ''),
    ('no frames', [], ''),
    ('repeats merge', ['a', 'a', 'b', 'b', 'b'], 'ab'),
    ('repeats across a blank', ['a', '<pad>', 'a'], 'aa'),
    ('blanks around and between', ['<pad>', '<pad>', 'm', '<pad>', 'a', 'a', '<pad>', '<pad>'], 'ma'),
    ('| at the start', ['|', 'a'], 'a'),
    ('| at the end', ['a', '|'], 'a'),
    ('| doubled', ['a', '|', '|', 'b'], 'a b'),
    ('| doubled across a blank', ['a', '|', '<pad>', '|', 'b'], 'a  b'),
    ('| and blanks only', ['|', '<pad>', '|', '<pad>'], ''),
    ('<s>, </s> and <unk> inside a word', ['a', '<s>', 'b', '</s>', 'c', '<unk>', 'd'], 'a<s>b</s>c<unk>d'),
    ('<unk> repeated, then across a blank', ['<unk>', '<unk>', '<pad>', '<unk>'], '<unk><unk>'),
    ('a | .', ['a', '|', '.'], 'a.'),
    ('a | , | b', ['a', '|', ',', '|', 'b'], 'a, b'),
    ('a | ? | b | !', ['a', '|', '?', '|', 'b', '|', '!'], 'a? b!'),
    ("n | ' | t", ['n', '|', "'", '|', 't'], "n't"),
    ("i t | ' s", ['i', 't', '|', "'", 's'], "it's"),
    ('digits', ['2', '0', '7', '|', '5', '<pad>', '5', '<pad>', '5', '|', '0', '1', '4', '2'],
     '207 555 0142'),
    ('é', ['c', 'a', 'f', 'é'], 'café'),
    ('è', ['m', 'è', 'r', 'e'], 'mère'),
    ('ç', ['ç', 'a'], 'ça'),
    ('combining acute after e', ['e', '́'], 'é'),
]


def decode_cases(tok, lang):
    vocab = tok.encoder
    out, skipped = [], []
    for name, tokens, expected in DECODE_CASES:
        if any(t not in vocab for t in tokens):
            skipped.append(name)
            continue
        ids = [int(vocab[t]) for t in tokens]
        text = tok.decode(ids, skip_special_tokens=False)
        if expected is not None and text != expected:
            raise GeneratorError(f'decode case {lang} {name!r}: {text!r}, expected {expected!r}')
        out.append({'name': name, 'ids': ids, 'text': text})
    return out, skipped


# --- 6. The run ---------------------------------------------------------------

def collapse(frame_ids):
    """CTC collapse: repeats merge, then the blank (0) is dropped."""
    out, prev = [], None
    for i in frame_ids:
        i = int(i)
        if i != prev and i != 0:
            out.append(i)
        prev = i
    return out


def peak_rss_bytes():
    r = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return r if sys.platform == 'darwin' else r * 1024  # bytes on macOS, KiB on Linux


def gib(n):
    return f'{n / (1 << 30):.2f} GiB'


def first_and_median(xs):
    rest = xs[1:]
    return xs[0], (statistics.median(rest) if rest else float('nan'))


def generate():
    t_start = time.perf_counter()
    versions = check_packages()

    # The Hugging Face libraries must never reach the network.
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

    # 1. Pins, before anything is loaded.
    pins = read_sums(PINS, comments=True)
    for _, folder, _, _ in ASR_GRAPHS:
        if not (BASE / folder).is_dir():
            raise Missing(f'the graph folder android/models/third_party/mms-1b-all/{folder}/ is missing. '
                          f'Produce it with: android/models/third_party/mms-1b-all/.venv/bin/python '
                          f'tools/export-mms/export-mms.py --lang {folder[5:]}')
    lid_exists = (BASE / LID_FOLDER).is_dir()
    lid_pinned = any(p.startswith(LID_FOLDER + '/') for p in pins)
    with_lid = lid_exists and lid_pinned
    if not lid_exists:
        log(f'note: {LID_FOLDER}/ does not exist: the golden omits graphs.lid and lid '
            f'(produce it with export-mms.py --lid)')
    elif not lid_pinned:
        log(f'note: {LID_FOLDER}/ exists but android/models/mms.SHA256SUMS does not pin it: '
            f'the golden omits graphs.lid and lid')

    files = {}
    t = time.perf_counter()
    total = 0
    for key, folder in [(k, f) for k, f, _, _ in ASR_GRAPHS] + ([('lid', LID_FOLDER)] if with_lid else []):
        files[key], size = verify_folder(folder, pins)
        total += size
    log(f'pins: {sum(len(v) for v in files.values())} files ({total:,} bytes) in '
        f'{len(files)} folders match their SHA256SUMS and android/models/mms.SHA256SUMS '
        f'({time.perf_counter() - t:.1f} s)')

    import numpy as np

    fixture_pins = read_sums(FIXTURE_PINS)
    clips, samples = [], {}
    for name in CLIPS:
        f = FIXTURES / f'{name}.wav'
        if not f.is_file():
            raise Missing(f'{rel(f)} is missing')
        digest = sha256_file(f)
        if fixture_pins.get(f.name) != digest:
            raise Missing(f'{rel(f)} is not the file {rel(FIXTURE_PINS)} pins ({digest})')
        x = read_wav(f, np)
        if x.dtype != np.float32:
            raise GeneratorError(f'{f.name} read as {x.dtype}')
        if len(x) > MAX_SAMPLES:
            raise GeneratorError(f'{f.name} has {len(x)} samples, over 30 s: this golden does not cover chunking')
        samples[name] = x
        clips.append({'name': name, 'file': f.name, 'sha256': digest, 'sampleCount': int(len(x))})
    log(f'fixtures: {len(clips)} WAVs match {rel(FIXTURE_PINS)}')

    import onnxruntime as ort
    import transformers
    from transformers import Wav2Vec2CTCTokenizer, Wav2Vec2FeatureExtractor

    site = Path(transformers.__file__).resolve().parents[1]
    src = Sources(site)
    if Path(np.__file__).resolve().parents[1] != site:
        raise GeneratorError('numpy and transformers are not installed in the same site-packages')

    # 2. Features. The four folders' preprocessor configs must agree (bar
    #    processor_class, which only the ASR folders carry and which only
    #    selects the pipeline type), and so must the extractors built from them.
    folders = [f for _, f, _, _ in ASR_GRAPHS] + ([LID_FOLDER] if with_lid else [])
    configs = {f: json.loads((BASE / f / 'preprocessor_config.json').read_text(encoding='utf-8'))
               for f in folders}
    ref_cfg = configs['onnx-lin']
    strip = lambda c: {k: v for k, v in c.items() if k != 'processor_class'}  # noqa: E731
    for f, c in configs.items():
        if strip(c) != strip(ref_cfg):
            raise GeneratorError(f'{f}/preprocessor_config.json differs from onnx-lin\'s: {c} vs {ref_cfg}')
    differing_keys = sorted({k for c in configs.values() for k in set(c) ^ set(ref_cfg)})
    log(f'preprocessor configs: {len(configs)} agree' +
        (f' (except {differing_keys}, absent from some)' if differing_keys else ''))
    feature_config = {k: ref_cfg[k] for k in FEATURE_CONFIG_KEYS}
    if feature_config['sampling_rate'] != SAMPLING_RATE or not feature_config['do_normalize'] \
            or feature_config['feature_size'] != 1:
        raise GeneratorError(f'unexpected preprocessor config {feature_config}')
    extractors = {f: Wav2Vec2FeatureExtractor.from_pretrained(str(BASE / f), local_files_only=True)
                  for f in folders}
    fe = extractors['onnx-lin']

    normalized = {}   # clip -> {'full': array, 'first3s': array}
    feature_clips = {}
    feature_times = []
    for name in CLIPS:
        x = samples[name]
        entry, arrays = {}, {}
        for window, data in (('full', x), ('first3s', x[:LID_WINDOW])):
            data = np.ascontiguousarray(data)
            t = time.perf_counter()
            out = fe(data, sampling_rate=SAMPLING_RATE, return_tensors='np')['input_values']
            if window == 'full':
                feature_times.append(time.perf_counter() - t)
            if out.dtype != np.float32 or out.shape != (1, len(data)):
                raise GeneratorError(f'{name} {window}: input_values {out.dtype} {out.shape}')
            y = out[0]
            for f, other in extractors.items():
                o = other(data, sampling_rate=SAMPLING_RATE, return_tensors='np')['input_values'][0]
                if not np.array_equal(o.view(np.uint32), y.view(np.uint32)):
                    raise GeneratorError(f'{name} {window}: {f}\'s extractor gives other values')
            # The mean and std exactly as zero_mean_unit_var_norm computes them.
            mean = data.mean()
            std = np.sqrt(data.var() + EPSILON)
            if mean.dtype != np.float32 or std.dtype != np.float32:
                raise GeneratorError(f'{name} {window}: mean {mean.dtype}, std {std.dtype}, not float32')
            again = (data - mean) / std
            if again.dtype != np.float32 or not np.array_equal(again.view(np.uint32), y.view(np.uint32)):
                raise GeneratorError(f'{name} {window}: (x - mean) / std does not reproduce the extractor')
            arrays[window] = y
            entry[window] = {'sampleCount': int(len(data)),
                             'meanStd': pack(np.array([mean, std], dtype=np.float32), np),
                             'sha256': f32_sha(y, np)}
        normalized[name] = arrays
        feature_clips[name] = entry
    log('features: 9 clips and their first 3 s; (x - mean) / std reproduces the extractor bit for bit; '
        f'the {len(extractors)} folders\' extractors agree')
    ff, fm = first_and_median(feature_times)
    log(f'features time (full clip, onnx-lin extractor): first {ff * 1e3:.2f} ms, median of the rest '
        f'{fm * 1e3:.2f} ms')

    features = {
        'config': feature_config,
        'epsilon': EPSILON,
        'lidWindowSamples': LID_WINDOW,
        'sources': feature_sources(src),
        'clips': feature_clips,
        'yes': pack(normalized['yes']['full'], np),
    }

    # 3. Tokenizers and the decoding facts.
    tokenizers = {}
    for key, folder, code, target in ASR_GRAPHS:
        tcfg = json.loads((BASE / folder / 'tokenizer_config.json').read_text(encoding='utf-8'))
        tok = Wav2Vec2CTCTokenizer.from_pretrained(str(BASE / folder), local_files_only=True)
        if tcfg.get('target_lang') != target or tok.target_lang != target:
            raise GeneratorError(f'{folder}: target_lang {tcfg.get("target_lang")!r} / {tok.target_lang!r}, '
                                 f'want {target!r}')
        vocab = json.loads((BASE / folder / 'vocab.json').read_text(encoding='utf-8'))[target]
        if tok.encoder != vocab:
            raise GeneratorError(f'{folder}: the tokenizer\'s vocabulary is not vocab.json[{target!r}]')
        if sorted(vocab.values()) != list(range(len(vocab))):
            raise GeneratorError(f'{folder}: vocab.json[{target!r}] ids are not 0..{len(vocab) - 1}')
        if vocab.get('<pad>') != 0 or tok.pad_token != '<pad>' or tok.pad_token_id != 0:
            raise GeneratorError(f'{folder}: the blank <pad> is not id 0')
        if tok.word_delimiter_token != '|' or tok.replace_word_delimiter_char != ' ':
            raise GeneratorError(f'{folder}: word delimiter {tok.word_delimiter_token!r} -> '
                                 f'{tok.replace_word_delimiter_char!r}')
        if tok.clean_up_tokenization_spaces is not True or tcfg.get('clean_up_tokenization_spaces') is not True:
            raise GeneratorError(f'{folder}: clean_up_tokenization_spaces is not true')
        if tok.do_lower_case:
            raise GeneratorError(f'{folder}: do_lower_case is set')
        tokenizers[key] = tok
        absent = [c for c in ('ɛ', 'ɔ', 'Ɛ', 'Ɔ') if c not in vocab]
        log(f'{key} vocabulary: {len(vocab)} tokens; absent from it: {" ".join(absent) or "none of ɛ ɔ Ɛ Ɔ"}')

    decoding = {
        'blankId': 0,
        'wordDelimiterToken': '|',
        'replaceWordDelimiterChar': ' ',
        'groupTokens': True,
        'skipSpecialTokens': False,
        'cleanUpTokenizationSpaces': True,
        'argmaxTies': 'first index',
        'sources': decoding_sources(src),
    }

    cases = {}
    for key, _, _, _ in ASR_GRAPHS:
        cases[key], skipped = decode_cases(tokenizers[key], key)
        log(f'decode cases {key}: {len(cases[key])}' +
            (f'; left out (a token not in the vocabulary): {skipped}' if skipped else ''))

    # 4. ASR, one fp32 session at a time.
    graphs, asr = {}, {}
    from optimum.onnxruntime import ORTModelForCTC
    from transformers import Wav2Vec2ForCTC
    from transformers import pipeline as hf_pipeline

    ctc_main_input = Wav2Vec2ForCTC.main_input_name  # a class attribute; no weights are loaded
    if ctc_main_input != 'input_values':
        raise GeneratorError(f'Wav2Vec2ForCTC.main_input_name is {ctc_main_input!r}')
    shim_where = [
        src.cite('transformers/pipelines/automatic_speech_recognition.py',
                 'self.model.main_input_name: model_inputs.pop(self.model.main_input_name),',
                 'the ASR pipeline reads model.main_input_name for CTC'),
        src.cite('optimum/modeling_base.py', 'class PreTrainedModel(ABC):  # noqa: F811',
                 'optimum\'s stub PreTrainedModel, which ORTModel derives from, has none'),
        src.cite('transformers/models/wav2vec2/modeling_wav2vec2.py', 'main_input_name = "input_values"',
                 'the value Wav2Vec2ForCTC inherits, set on the ORTModelForCTC instance',
                 scope='Wav2Vec2PreTrainedModel'),
    ]
    shimmed = []

    ignored = {'n': 0}

    class CountIgnored:
        """optimum warns on every call that ORTModelForCTC ignores attention_mask; count it."""

        def filter(self, record):
            if 'received attention_mask' in record.getMessage():
                ignored['n'] += 1
                return False
            return True

    import logging
    logging.getLogger('optimum.onnxruntime.modeling_ort').addFilter(CountIgnored())

    for key, folder, code, target in ASR_GRAPHS:
        tok = tokenizers[key]
        t = time.perf_counter()
        sess = ort.InferenceSession(str(BASE / folder / 'model.onnx'), providers=SESSION_PROVIDERS)
        load = time.perf_counter() - t
        if sess.get_providers() != SESSION_PROVIDERS:
            raise GeneratorError(f'{folder}: providers {sess.get_providers()}')
        inputs = [i.name for i in sess.get_inputs()]
        outputs = [o.name for o in sess.get_outputs()]
        out_dim = sess.get_outputs()[0].shape[-1]
        if inputs != ['input_values'] or outputs != ['logits']:
            raise GeneratorError(f'{folder}: inputs {inputs}, outputs {outputs}')
        if not isinstance(out_dim, int) or out_dim != tok.vocab_size:
            raise GeneratorError(f'{folder}: logits last dim {out_dim!r}, the tokenizer has {tok.vocab_size}')
        graphs[key] = {'folder': folder, 'code': code, 'targetLang': target, 'files': files[key],
                       'inputNames': inputs, 'outputNames': outputs, 'outputDim': out_dim}

        per_clip, model_times, decode_times = {}, [], []
        for name in CLIPS:
            x = normalized[name]['full'][None, :]
            t = time.perf_counter()
            logits = sess.run(None, {'input_values': x})[0]
            model_times.append(time.perf_counter() - t)
            if logits.dtype != np.float32 or logits.ndim != 3 or logits.shape[0] != 1 \
                    or logits.shape[2] != out_dim:
                raise GeneratorError(f'{key} {name}: logits {logits.dtype} {logits.shape}')
            frames = logits[0]
            t = time.perf_counter()
            frame_ids = np.argmax(frames, axis=-1)
            ids = collapse(frame_ids)
            text = tok.decode(frame_ids, skip_special_tokens=False)
            decode_times.append(time.perf_counter() - t)
            top2 = np.sort(frames, axis=-1)[:, -2:]
            gaps = top2[:, 1] - top2[:, 0]
            if gaps.dtype != np.float32:
                raise GeneratorError(f'{key} {name}: gaps are {gaps.dtype}')
            per_clip[name] = {'frameIds': [int(i) for i in frame_ids], 'ids': ids, 'text': text,
                              'gaps': pack(gaps, np)}
        asr[key] = per_clip
        del sess
        gc.collect()
        mf, mm = first_and_median(model_times)
        df, dm = first_and_median(decode_times)
        log(f'{key} ({folder}/model.onnx): load {load:.2f} s; model first {mf:.3f} s, median of the rest '
            f'{mm:.3f} s; decode first {df * 1e3:.3f} ms, median of the rest {dm * 1e3:.3f} ms; '
            f'peak RSS so far {gib(peak_rss_bytes())}')
        for name in CLIPS:
            e = per_clip[name]
            log(f'  {key} {name:<14} {len(e["frameIds"]):>4} frames {len(e["ids"]):>3} ids '
                f'text {json.dumps(e["text"], ensure_ascii=False)}')

        # The cross-check: transformers' own ASR pipeline over optimum's
        # ORTModelForCTC on the same fp32 graph must give the same text.
        t = time.perf_counter()
        model = ORTModelForCTC.from_pretrained(str(BASE / folder), file_name='model.onnx',
                                               local_files_only=True, provider='CPUExecutionProvider')
        if not hasattr(model, 'main_input_name'):
            # optimum 1.27.0's ORTModel derives from a stub PreTrainedModel(ABC)
            # (optimum/modeling_base.py) without main_input_name, which
            # transformers 4.53.3's ASR pipeline reads for CTC models. optimum
            # has no other pipeline route for ORTModelForCTC (its own
            # pipeline() maps ASR to ORTModelForSpeechSeq2Seq only, then calls
            # transformers' pipeline the same way). Give the instance the value
            # transformers' own Wav2Vec2ForCTC declares; nothing else changes.
            model.main_input_name = ctc_main_input
            shimmed.append(key)
        # device='cpu': otherwise the pipeline picks MPS when torch sees it,
        # and runs its tensors and argmax there.
        pipe = hf_pipeline('automatic-speech-recognition', model=model, tokenizer=tok,
                           feature_extractor=extractors[folder], device='cpu')
        if pipe.type != 'ctc':
            raise GeneratorError(f'{key}: the pipeline type is {pipe.type!r}, not "ctc"')
        if pipe.device.type != 'cpu' or model.session.get_providers() != SESSION_PROVIDERS:
            raise GeneratorError(f'{key}: the pipeline runs on {pipe.device}, providers '
                                 f'{model.session.get_providers()}')
        same = 0
        for name in CLIPS:
            got = pipe(samples[name].copy())['text']
            if got != per_clip[name]['text']:
                raise GeneratorError(f'{key} {name}: the pipeline gives {got!r}, the golden '
                                     f'{per_clip[name]["text"]!r}')
            same += 1
        del pipe, model
        gc.collect()
        log(f'{key} cross-check: pipeline("automatic-speech-recognition") over ORTModelForCTC '
            f'gives the same text on {same} of {len(CLIPS)} clips ({time.perf_counter() - t:.1f} s); '
            f'peak RSS so far {gib(peak_rss_bytes())}')
    log(f'ORTModelForCTC ignored the attention_mask the pipeline passed on {ignored["n"]} calls '
        f'(the graphs take input_values only)')
    if shimmed:
        log(f'cross-check shim for {", ".join(shimmed)}: ORTModelForCTC.main_input_name = '
            f'{ctc_main_input!r}; ' + '; '.join(shim_where))

    golden = {
        'generator': GENERATOR,
        'versions': {'python': platform.python_version(), **versions,
                     'platform': f'{sys.platform}-{platform.machine()}'},
        'sessionOptions': {'providers': SESSION_PROVIDERS, 'options': 'onnxruntime.SessionOptions() defaults'},
        'clips': clips,
        'features': features,
        'decoding': decoding,
        'graphs': graphs,
        'asr': asr,
    }

    # 5. Language ID on the first 3 s.
    if with_lid:
        cfg = json.loads((BASE / LID_FOLDER / 'config.json').read_text(encoding='utf-8'))
        id2label = cfg['id2label']
        if sorted(id2label, key=int) != [str(i) for i in range(len(id2label))]:
            raise GeneratorError(f'{LID_FOLDER}/config.json id2label keys are not 0..{len(id2label) - 1}')
        labels = [id2label[str(i)] for i in range(len(id2label))]
        if len(set(labels)) != len(labels):
            raise GeneratorError(f'{LID_FOLDER}/config.json has repeated labels')
        indices = {lang: labels.index(lang) for lang in CANDIDATES}
        t = time.perf_counter()
        sess = ort.InferenceSession(str(BASE / LID_FOLDER / 'model.onnx'), providers=SESSION_PROVIDERS)
        load = time.perf_counter() - t
        if sess.get_providers() != SESSION_PROVIDERS:
            raise GeneratorError(f'{LID_FOLDER}: providers {sess.get_providers()}')
        inputs = [i.name for i in sess.get_inputs()]
        outputs = [o.name for o in sess.get_outputs()]
        out_dim = sess.get_outputs()[0].shape[-1]
        if inputs != ['input_values'] or outputs != ['logits'] or out_dim != len(labels):
            raise GeneratorError(f'{LID_FOLDER}: inputs {inputs}, outputs {outputs}, last dim {out_dim!r}, '
                                 f'{len(labels)} labels')
        graphs['lid'] = {'folder': LID_FOLDER, 'code': None, 'targetLang': None, 'files': files['lid'],
                         'inputNames': inputs, 'outputNames': outputs, 'outputDim': out_dim,
                         'labels': labels, 'candidates': dict(CANDIDATES), 'candidateIndices': indices}
        lid, model_times = {}, []
        for name in CLIPS:
            x = normalized[name]['first3s'][None, :]
            t = time.perf_counter()
            logits = sess.run(None, {'input_values': x})[0]
            model_times.append(time.perf_counter() - t)
            if logits.dtype != np.float32 or logits.shape != (1, out_dim):
                raise GeneratorError(f'lid {name}: logits {logits.dtype} {logits.shape}')
            v = logits[0]
            v64 = v.astype(np.float64)
            e = np.exp(v64 - v64.max())
            p = e / e.sum()
            lid[name] = {'logits': pack(v, np), 'top': labels[int(np.argmax(v))],
                         'probabilities': {lang: float(p[i]) for lang, i in indices.items()}}
        del sess
        gc.collect()
        golden['lid'] = lid
        mf, mm = first_and_median(model_times)
        log(f'lid ({LID_FOLDER}/model.onnx): load {load:.2f} s; model first {mf:.3f} s, median of the rest '
            f'{mm:.3f} s; peak RSS so far {gib(peak_rss_bytes())}')
        log(f'  lid labels: {", ".join(f"{k}={i}" for k, i in indices.items())} of {len(labels)}')
        for name in CLIPS:
            e = lid[name]
            log(f'  lid {name:<14} top {e["top"]:<4} ' +
                ' '.join(f'{k}={json.dumps(v)}' for k, v in e['probabilities'].items()))
        # Step 1's export reported its fp32 labels; a printed comparison only.
        parity = BASE / 'parity-lid.json'
        if parity.is_file():
            try:
                labels_then = json.loads(parity.read_text(encoding='utf-8'))['argmax_labels']
                agree = sum(labels_then[n]['fp32'] == lid[n]['top'] for n in CLIPS)
                log(f'  lid top labels equal parity-lid.json\'s fp32 labels on {agree} of {len(CLIPS)} clips')
            except (KeyError, TypeError, ValueError) as err:
                log(f'  (parity-lid.json not compared: {err!r})')

    golden['decodeCases'] = cases
    log(f'generated in {time.perf_counter() - t_start:.1f} s; peak RSS {gib(peak_rss_bytes())}')
    return golden


def main(argv):
    if argv and argv[0] in ('-h', '--help'):
        log(USAGE)
        return 0
    checking, check_path = False, DEST
    if argv:
        if argv[0] != '--check' or len(argv) > 2:
            print(USAGE, file=sys.stderr)
            return 3
        checking = True
        if len(argv) == 2:
            check_path = Path(argv[1]).resolve()

    golden = generate()
    text = json.dumps(golden, ensure_ascii=False, indent=1) + '\n'
    if str(ROOT) in text:
        raise GeneratorError('the golden would contain an absolute path, which must never be committed')
    data = text.encode('utf-8')

    if not checking:
        DEST.parent.mkdir(parents=True, exist_ok=True)
        DEST.write_bytes(data)
        log(f'golden {rel(DEST)} ({len(data)} bytes)')
        return 0

    if not check_path.is_file():
        log(f'mms golden missing: {rel(check_path)}')
        return 1
    stored = check_path.read_bytes()
    if stored == data:
        log(f'mms golden fresh ({len(data)} bytes)')
        return 0
    log(f'mms golden is stale: {rel(check_path)}')
    try:
        parsed = json.loads(stored.decode('utf-8'))
    except (UnicodeDecodeError, ValueError):
        print('  stored: not JSON', file=sys.stderr)
        return 1
    before = (parsed.get('versions') or {}).get('platform') if isinstance(parsed, dict) else None
    now = golden['versions']['platform']
    if before != now:
        print(f'note: the golden was recorded on {before}, this machine is {now}; '
              'frame ids may legitimately differ', file=sys.stderr)
    differing = diff_paths(parsed, json.loads(text))
    for p in differing:
        print(f'  differs at {p}', file=sys.stderr)
    if not differing:
        print('  same JSON, different bytes', file=sys.stderr)
    return 1


if __name__ == '__main__':
    try:
        code = main(sys.argv[1:])
    except Missing as err:
        print(f'mms.py: {err}', file=sys.stderr)
        code = 2
    except GeneratorError as err:
        print(f'mms.py: {err}', file=sys.stderr)
        code = 3
    except Exception:  # noqa: BLE001 - any other failure is exit 3, with its traceback
        import traceback
        traceback.print_exc()
        code = 3
    sys.exit(code)
