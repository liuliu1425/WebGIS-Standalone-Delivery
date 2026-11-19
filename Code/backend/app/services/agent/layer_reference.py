"""Small, shared normalization for user-facing product references.

Only names are normalized here; stable catalog and instance identifiers remain untouched.
"""
import re
import unicodedata


def normalize_reference(text: str) -> str:
    value = unicodedata.normalize("NFKC", str(text or "")).casefold()
    value = re.sub(r"(?<![a-z])v\s+o\s+d(?![a-z])", "vod", value)
    value = re.sub(r"(?<![a-z])s\s+m\s+a\s+p(?![a-z])", "smap", value)
    value = re.sub(r"(?<![a-z])s\s+m(?![a-z])", "sm", value)
    value = re.sub(r"(smap|fy(?:-?\s*[34][a-z]?)?)(?=vod|sm(?!ap)|omega)", r"\1 ", value)
    value = re.sub(r"(?<![a-z])(?:avg|average)(?![a-z])", "平均版", value)
    value = re.sub(r"(?<![a-z])dynamic(?![a-z])", "动态版", value)
    value = value.replace("均版", "平均版").replace("动版", "动态版")
    return value


def reference_hints(text: str) -> dict[str, str]:
    value = normalize_reference(text)
    hints: dict[str, str] = {}
    has_smap = bool(re.search(r"smap|斯玛普", value))
    has_fy = bool(re.search(r"风云|风三|风四|nsmc|(?<![a-z])fy(?:-?\s*[34][a-z]?)?(?![a-z])", value))
    if has_smap and has_fy:
        hints["source"] = "ambiguous"
    elif has_smap:
        hints["source"] = "smap"
    elif re.search(r"风云|风三|风四|nsmc|(?<![a-z])fy(?:-?\s*[34][a-z]?)?(?![a-z])", value):
        hints["source"] = "fy"
    if re.search(r"动态", value):
        hints["family"] = "dynamic"
    if re.search(r"平均(?!值|多少|是|为|约|大概|下|一|的|数|量)|月均|季均|气候态", value):
        hints["family"] = "ambiguous" if hints.get("family") == "dynamic" else "average"
    # The family name contains '散射', which does not identify the omega variable.
    variable_text = re.sub(r"(?:(?:动态|平均)\s*)?散射约束(?:产品|模型)?", "", value)
    found = []
    for key, pattern in (
        ("vod", r"(?<![a-z])vod(?![a-z])|植被光学厚度|光学厚度"),
        ("sm", r"(?<![a-z])sm(?![a-z])|土壤水|土壤湿|soil\s*moisture|含水量|墒情"),
        ("omega", r"(?<![a-z])omega(?![a-z])|ω|等效散射|单次散射|散射率"),
    ):
        if re.search(pattern, variable_text):
            found.append(key)
    if len(found) == 1:
        hints["variable"] = found[0]
    elif len(found) > 1:
        hints["variable"] = "ambiguous"
    return hints
