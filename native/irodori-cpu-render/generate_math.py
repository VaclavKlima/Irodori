"""Generate this prototype's Float64 ACES implementation from pinned CTL.

Usage: python3 native/irodori-cpu-render/generate_math.py OUTPUT_INCLUDE
The generator is independent of application-generated math and the test adapter.
CTL array value semantics and default zero initialization are preserved. Only
read-only ODTParams function parameters become const references: their source
bodies are checked for direct writes before that conversion. This lexical check
is scoped to the SHA-pinned sources, not general alias analysis. Generated C++
const qualification must also compile: an attempt to pass a borrowed member to
an output reference is rejected by C++ rather than repaired by the generator.
"""

import hashlib
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
LIB = ROOT / "third_party/aces-core/lib"
REVISION = "069b0bc3e1f6c62820f19fdae2fecec3f4fc0f80"
PINS = {
    "Lib.Academy.Utilities.ctl": "142ad05f16816c76eacf70ed9d3d6eb8778029b0e497900867abbf21d712fb03",
    "Lib.Academy.Tonescale.ctl": "fcb99aad7fdf52ae048886171c18af9107ceeee2709aa33233ef09636fd1c6c4",
    "Lib.Academy.OutputTransform.ctl": "34a23e14e29dff47f5575514b7c98f502e2be7784a81709a9ca9b53777b2fdfe",
    "Lib.Academy.ColorSpaces.ctl": "4f07503e00127b00719416d63446d9a6b504798111d94f3860eb74754b6fb00a",
}


def load_sources():
    sources = {}
    for name, expected in PINS.items():
        data = (LIB / name).read_bytes()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"Pinned ACES source checksum mismatch: {name}")
        sources[name] = data.decode("utf-8")
    # Utilities supplies RGBtoXYZ_f33/XYZtoRGB_f33, and OutputTransform supplies
    # AP0/AP1. ColorSpaces is pinned but is unnecessary here: its adaptation
    # functions are used only when deriving the input matrix. The caller supplies
    # the application's exact Rec.2020-to-ACES matrix instead of deriving it again.
    utilities = sources["Lib.Academy.Utilities.ctl"]
    utilities = utilities[:utilities.index("void print_f2")]
    return "\n".join([
        utilities,
        sources["Lib.Academy.Tonescale.ctl"],
        sources["Lib.Academy.OutputTransform.ctl"],
    ])


def readonly_odt_parameters(source):
    """Borrow pinned input-only structs; preserve output-array references.

    The direct-write check is intentionally bounded to this pinned CTL revision.
    Nested calls continue to use their translated signatures, whose output
    parameters are mutable references. C++ therefore rejects any attempted write
    through a const ODTParams member, including passing it to an output argument.
    """
    signature = re.compile(
        r"\b(?:float|int|bool|void|\w+Params)(?:\[[^\]]*\])*\s+"
        r"\w+\s*\(([^{}]*?)\)\s*\{",
        re.S,
    )
    replacements = []
    for match in signature.finditer(source):
        parameters = list(re.finditer(r"\bODTParams\s+(\w+)\b", match[1]))
        if not parameters:
            continue
        end = match.end()
        depth = 1
        while depth:
            if source[end] == "{":
                depth += 1
            elif source[end] == "}":
                depth -= 1
            end += 1
        body = source[match.end():end - 1]
        for parameter in parameters:
            name = re.escape(parameter[1])
            member = rf"\b{name}(?:\s*\.\s*\w+|\s*\[[^\]]+\])*"
            if re.search(member + r"\s*(?:[+*/%&|^\-]?=(?!=)|\+\+|--)", body):
                raise ValueError("Cannot borrow a modified ODTParams parameter")
            if re.search(rf"(?:\+\+|--)\s*\b{name}\b|&\s*\b{name}\b", body):
                raise ValueError("Cannot borrow an escaping ODTParams parameter")
        arguments = re.sub(r"\bODTParams\s+(\w+)\b", r"const ODTParams& \1", match[1])
        replacements.append((match.start(1), match.end(1), arguments))
    if not replacements:
        raise ValueError("No read-only ODTParams parameters found")
    for start, end, arguments in reversed(replacements):
        source = source[:start] + arguments + source[end:]
    return source


def array_type(dimensions, kind="double"):
    result = kind
    for dimension in reversed(re.findall(r"\[([^\]]*)\]", dimensions)):
        result = f"std::array<{result},{dimension or 'totalTableSize'}>"
    return result


def extra_array_braces(source):
    position = 0
    pattern = r"std::array<std::array<[^;=]+>\s+\w+\s*=\s*\{"
    while match := re.search(pattern, source[position:]):
        start = position + match.end() - 1
        end = start + 1
        depth = 1
        while depth:
            if source[end] == "{":
                depth += 1
            elif source[end] == "}":
                depth -= 1
            end += 1
        source = source[:start] + "{" + source[start:end] + "}" + source[end:]
        position = end + 2
    return source


def translate(source):
    source = re.sub(r"/\*.*?\*/|//[^\n]*", "", source, flags=re.S)
    source = readonly_odt_parameters(source)
    source = re.sub(r"\bunsigned int\b", "int", source)
    source = re.sub(r"\bfloat\b", "double", source)
    source = re.sub(r"\binput\s+", "", source)
    source = source.replace(".size", ".size()")
    source = re.sub(r"\b(min|max|round|copysign|ceil|log2)\b", r"ctl_\1", source)
    source = re.sub(r"\bin\b", "inputValue", source)
    source = re.sub(r"\bM_PI\b", "M_PI_VALUE", source)
    source = re.sub(
        r"(double|int)((?:\[[^\]]*\])+)",
        lambda match: array_type(match[2], match[1]),
        source,
    )
    declaration = re.compile(r"(output\s+)?(double|int)\s+(\w+)((?:\[[^\]]*\])+)", re.S)
    source = declaration.sub(
        lambda match: array_type(match[4], match[2])
        + (" &" if match[1] else " ") + match[3],
        source,
    )
    source = extra_array_braces(source)
    source = re.sub(r"\boutput\s+(\w+)\s+(\w+)", r"\1 &\2", source)
    source = re.sub(
        r"((?:std::array<[^;=\n]+>|double|int|bool|TSParams|JMhParams|ODTParams|HueDependentGamutParams)\s+\w+)\s*;",
        r"\1{};",
        source,
    )
    # These are supplied before CTL functions for initialization helpers.
    source = re.sub(r"double ctl_(?:min|max)\([^}]+\}", "", source)
    source = re.sub(r"const int totalTableSize\s*=\s*[^;]+;", "", source)
    return source


PREFIX = r'''
#include <array>
#include <cmath>

namespace irodori_cpu_aces {
constexpr int totalTableSize = 362;
constexpr double M_PI_VALUE = 3.14159265358979323846;
using V = std::array<double, 3>;
using M = std::array<V, 3>;
struct Chromaticities { std::array<double, 2> red, green, blue, white; };
double ctl_min(double a, double b) { return a < b ? a : b; }
double ctl_max(double a, double b) { return a > b ? a : b; }
double ctl_round(double a);
double ctl_copysign(double a, double b);
double pow10(double value) { return std::pow(10., value); }
M invert_f33(M value) {
    M result{};
    const double determinant =
        value[0][0] * (value[1][1] * value[2][2] - value[1][2] * value[2][1])
        - value[0][1] * (value[1][0] * value[2][2] - value[1][2] * value[2][0])
        + value[0][2] * (value[1][0] * value[2][1] - value[1][1] * value[2][0]);
    for (int row = 0; row < 3; ++row)
        for (int column = 0; column < 3; ++column)
            result[column][row] =
                (value[(row + 1) % 3][(column + 1) % 3] * value[(row + 2) % 3][(column + 2) % 3]
                 - value[(row + 1) % 3][(column + 2) % 3] * value[(row + 2) % 3][(column + 1) % 3])
                / determinant;
    return result;
}
V mult_f3_f33(V value, M matrix) {
    return {
        value[0] * matrix[0][0] + value[1] * matrix[1][0] + value[2] * matrix[2][0],
        value[0] * matrix[0][1] + value[1] * matrix[1][1] + value[2] * matrix[2][1],
        value[0] * matrix[0][2] + value[1] * matrix[1][2] + value[2] * matrix[2][2]
    };
}
V mult_f_f3(double scale, V value) {
    for (auto& channel : value) channel *= scale;
    return value;
}
M mult_f_f33(double scale, M matrix) {
    for (auto& row : matrix) row = mult_f_f3(scale, row);
    return matrix;
}
M mult_f33_f33(M first, M second) {
    for (auto& row : first) row = mult_f3_f33(row, second);
    return first;
}
'''


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: generate_math.py OUTPUT_INCLUDE")
    source = translate(load_sources())
    provenance = "// Generated directly from pinned ACES CTL; Apache-2.0.\n"
    provenance += f"// ACES revision: {REVISION}\n"
    for name, digest in PINS.items():
        provenance += f"// SHA-256 {name}: {digest}\n"
    Path(sys.argv[1]).write_text(
        provenance + PREFIX + source + "\n} // namespace irodori_cpu_aces\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
