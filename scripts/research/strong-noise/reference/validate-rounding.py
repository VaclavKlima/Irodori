"""Check direct integer binary32 rounding against explicit IEEE word vectors."""
from decimal import Decimal, localcontext
import importlib.util
import json
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('independent_direct_rounding', HERE / 'reference.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
checks = 0
with localcontext() as context:
    # Represent binary tie rationals exactly, including 2^-150; this validates
    # the integer conversion independently of Decimal80 feature arithmetic.
    context.prec = 300
    d = Decimal
    vectors = [(d(0), 0), (d('-0'), 0x80000000),
        (d(2) ** -150, 0), (3 * d(2) ** -150, 2),
        (5 * d(2) ** -150, 2),
        (d(2) ** -126 - d(2) ** -150, 0x00800000),
        ((2 - d(2) ** -23) * d(2) ** 127, 0x7f7fffff)]
    for exponent in range(-126, 128):
        value = d(2) ** exponent
        word = (exponent + 127) << 23
        vectors.extend([(value, word), (value + d(2) ** (exponent - 24), word),
                        (value + 3 * d(2) ** (exponent - 24), word + 2)])
    for value, expected in vectors:
        actual = module.binary32_word(value)
        if actual != expected:
            raise AssertionError((str(value), hex(actual), hex(expected)))
        checks += 1
        if value:
            assert module.binary32_word(-value) == (expected | 0x80000000)
            checks += 1
    try:
        module.binary32_word((2 - d(2) ** -24) * d(2) ** 127)
    except ValueError:
        checks += 1
    else:
        raise AssertionError('Overflow tie must not publish an unreported infinity.')
destination = Path(sys.argv[1])
with destination.open('x') as stream:
    json.dump({'status': 'passed', 'checks': checks, 'tieVectorPrecision': 300,
               'scope': 'Integer binary32 converter only; no denoiser or Decimal80 RGB comparison.'}, stream, indent=2)
    stream.write('\n')
print(json.dumps({'roundingChecks': checks, 'status': 'passed'}))
