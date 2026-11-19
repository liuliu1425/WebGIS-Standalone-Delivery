#!/usr/bin/env python3
"""Check a staged source tree without printing matched values."""

import argparse
import hashlib
import json
import re
import stat
import sys
from dataclasses import asdict, dataclass
from pathlib import Path


README_NAMES = {"readme", "readme.md", "readme.rst", "readme.txt", "readme.adoc"}
SOURCE_SUFFIXES = set("""
    .py .pyi .js .jsx .mjs .cjs .ts .tsx .vue .svelte .css .scss .sass .less
    .html .htm .svg .xml .xsd .xsl .json .jsonc .json5 .yaml .yml .toml .ini
    .cfg .conf .config .properties .sql .sh .bash .zsh .ps1 .psm1 .psd1
    .bat .cmd .go .rs .java .kt .c .h .cpp .hpp .cs .fs .rb .php .lua .ipynb
""".split())
SOURCE_NAMES = {"makefile", "cmakelists.txt", "procfile", "jenkinsfile", "gemfile"}
EXAMPLE_TAGS = {"example", "sample", "template", "dist"}
PRIVATE_DIRS = {
    ".git", ".ssh", ".aws", ".kube", ".venv", "__pycache__", "node_modules",
    "_runtime", ".secrets",
}
PRIVATE_NAMES = {
    ".envrc", ".netrc", ".git-credentials", ".pgpass", "credentials", "credentials.json",
    "credentials.xml", "credentials.yml", "credentials.yaml", "secrets.json",
    "secrets.yml", "secrets.yaml", "runtime-credential.xml",
    "id_dsa", "id_ecdsa", "id_ed25519", "id_rsa",
}
DB_FILE = re.compile(
    r"\.(?:db|sqlite3?|duckdb|mdb|accdb|rdb|aof|dump)(?:[-.](?:wal|shm|journal|bak|gz|zip))?$",
    re.IGNORECASE,
)
LOCAL_TEST = re.compile(r"(?:^|[-_. ])local[-_. ]?test(?:$|[-_. ])", re.IGNORECASE)
VENDOR_TOKEN = re.compile(
    r"\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|"
    r"glpat-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|"
    r"sk-(?:proj-|svcacct-)[A-Za-z0-9_-]{30,}|sk_live_[A-Za-z0-9]{20,}|"
    r"xox[baprs]-[A-Za-z0-9-]{24,}|AIza[A-Za-z0-9_-]{35})\b"
)
PRIVATE_KEY = re.compile(
    r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\s*(?:\\[rn])?\s*[A-Za-z0-9+/]{32,}"
)
JWT = re.compile(r"\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,}\b")
AUTH_URL = re.compile(
    r"\b[a-z][a-z0-9+.-]*://([^\s\"'@]+)@(\[[^\]\s]+\]|[A-Za-z0-9_.-]+)", re.I
)
ASSIGNMENT = re.compile(
    r"""(?<![\w.])["']?([A-Za-z_][\w.-]*)["']?\s*(?:=(?!=)|:\s*)\s*"""
    r"""(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s,;#'"\x60{}\[\]]+))"""
)
PRIVATE_FIELD = re.compile(
    r"(?:^|_)(?:password|passwd|pwd|password_hash|api_key|"
    r"private_key|secret_key|client_secret|access_key|access_key_id|"
    r"access_token|refresh_token|auth_token|bearer_token|token|secret|"
    r"authorization|username|(?:admin|db|postgres|smtp|minio|nas|service)_user)(?:$|_)", re.IGNORECASE,
)
FIXED_PATH = re.compile(
    r"(?<![A-Za-z0-9_])(?:[A-Z]:/+(?:Users|Project|Projects|ProgramData|"
    r"GeoFlow[-_][A-Za-z_-]+)(?:/[^/\s'\"<>]+|(?=$|[\s'\"<>]))|"
    r"/+(?:home|Users)/[^/\s'\"<>]+|file:/+[A-Z]:/+)",
    re.IGNORECASE,
)
UNC_PATH = re.compile(r"(?<!\\)\\\\(?:\\\\)?[A-Za-z0-9_.-]+\\{1,2}[^\\/\s'\"<>]+")
OPAQUE_SUFFIXES = (".zip", ".tar", ".tgz", ".tar.gz", ".7z", ".rar", ".tar.xz", ".tar.bz2")
KNOWN_BINARY_SUFFIXES = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".woff", ".woff2",
    ".ttf", ".otf", ".mp3", ".mp4", ".tif", ".tiff", ".shp", ".shx", ".dbf",
    ".nc", ".h5", ".hdf5", ".npy", ".npz",
}
PLACEHOLDER = re.compile(
    r"^(?:your(?:[-_ ].+)?|replace(?:[-_ ].+)?|change[-_ ]?me(?:[-_ ].+)?|"
    r"(?:example|placeholder|dummy|sample|mock|fake)(?:[-_ ].+)?|"
    r"(?:insert|set)[-_ ](?:your|a)[-_ ].+|<[^>]+>|\*{3,}|[xX]{4,})$",
    re.IGNORECASE,
)
REVIEW_CODES = {"credential-literal", "jwt-literal", "opaque-archive", "oversized-text"}


@dataclass(frozen=True, order=True)
class Finding:
    path: str
    line: int
    severity: str
    code: str


def is_example(name):
    return name.rsplit(".", 1)[-1] in EXAMPLE_TAGS


def is_env_filename(name):
    return (
        name in {"env", ".env"}
        or name.startswith(".env.")
        or name.endswith(".env")
        or bool(re.search(r"(?:^|\.)env\.(?:local|dev|development|prod|production|test|staging)(?:\.|$)", name))
        or (is_example(name) and name.rsplit(".", 1)[0].endswith(".env"))
    )


def forbidden(name, is_directory):
    name = name.casefold()
    if LOCAL_TEST.search(name):
        return "local-test"
    if is_directory:
        return "private-directory" if name in PRIVATE_DIRS else None
    if is_env_filename(name) and not is_example(name):
        return "live-environment"
    if name in PRIVATE_NAMES or name.endswith((".pfx", ".p12", ".key", ".kdbx")):
        return "private-credential-file"
    if DB_FILE.search(name):
        return "runtime-database"
    return None


def is_source(path):
    name = path.name.casefold()
    if name in README_NAMES or name in {".gitignore", ".gitkeep"}:
        return False
    if name in SOURCE_NAMES or name.startswith(("dockerfile", "containerfile")):
        return True
    if is_example(name):
        name = name.rsplit(".", 1)[0]
    return is_env_filename(name) or Path(name).suffix in SOURCE_SUFFIXES


def normalized_path(value):
    return re.sub(r"[/\\]+", "/", value).casefold()


def is_example_path(value):
    return bool(re.search(r"/(?:users|home)/(?:example|your[-_]?user(?:name)?)/?$", value))


def is_concrete(value):
    value = value.strip()
    if not value or value.casefold() in {
        "none", "null", "undefined", "false", "true", "required", "optional",
        "username", "string", "str",
    }:
        return False
    return not value.startswith(("\x24", "{{", "%(")) and not PLACEHOLDER.fullmatch(value)


def has_credential_literal(line, config_file):
    if line.lstrip().startswith(("#", "//", "*", "<!--")):
        return False
    for match in ASSIGNMENT.finditer(line):
        key = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", match[1]).replace("-", "_").replace(".", "_").casefold()
        if not PRIVATE_FIELD.search(key):
            continue
        quoted = match[2] is not None or match[3] is not None
        value = next(part for part in match.groups()[1:] if part is not None)
        if not is_concrete(value):
            continue
        if key.endswith(("token_type", "token_count", "token_limit", "_seconds", "_ttl", "_enabled")):
            continue
        if key.endswith(("username", "_user")) and value.casefold() in {"anonymous", "guest", "postgres", "admin", "root"}:
            continue
        if not quoted and not config_file and (value.isdecimal() or re.fullmatch(r"[A-Za-z_][\w.]*", value)):
            continue
        if not quoted and ("(" in value or value.startswith(("os.", "process.", "settings.", "config.", "env."))):
            continue
        return True
    return False


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="staged delivery directory")
    parser.add_argument("--deny-host", action="append", default=[], metavar="HOST")
    parser.add_argument("--deny-path", action="append", default=[], metavar="PATH")
    parser.add_argument("--allow-review", action="append", default=[], metavar="CODE:FILE")
    parser.add_argument("--max-text-mib", default=16, type=int, metavar="MIB")
    parser.add_argument("--fail-on-review", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    hosts = [host.casefold().strip().strip(".") for host in args.deny_host]
    if any(not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+", host) for host in hosts):
        parser.error("--deny-host expects a hostname without a scheme, port or path")
    args.host_patterns = [
        re.compile(r"(?<![A-Za-z0-9_-])" + re.escape(host) + r"(?![A-Za-z0-9_-]|\.[A-Za-z0-9])", re.I)
        for host in hosts
    ]
    args.path_patterns = [
        re.compile(r"(?<![\w-])" + re.escape(normalized_path(path).rstrip("/")) + r"(?![\w.-])")
        for path in args.deny_path if path.strip(" /\\")
    ]
    if len(args.path_patterns) != len(args.deny_path):
        parser.error("--deny-path expects a nonempty path")
    args.review_exceptions = set()
    for exception in args.allow_review:
        code, _, path = exception.partition(":")
        path = path.replace("\\", "/")
        if code not in REVIEW_CODES or not path or ":" in path or path.startswith("/") or ".." in path.split("/"):
            parser.error("--allow-review expects a review code and an exact relative file path")
        args.review_exceptions.add((code, path))
    if args.max_text_mib < 1:
        parser.error("--max-text-mib must be positive")
    return args


def is_link(entry_stat):
    return stat.S_ISLNK(entry_stat.st_mode) or bool(
        getattr(entry_stat, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    )


def line_checks(line, args, config_file):
    normalized = normalized_path(line)
    if any(pattern.search(line) for pattern in args.host_patterns):
        yield "error", "blocked-host"
    pinned_path = any(pattern.search(normalized) for pattern in args.path_patterns)
    real_unc = any(
        normalized_path(match[0]) not in {"/server/share", "/nas.example.org/share"}
        for match in UNC_PATH.finditer(line)
    )
    if pinned_path:
        yield "error", "blocked-path"
    elif real_unc or any(not is_example_path(match[0]) for match in FIXED_PATH.finditer(normalized)):
        yield "review", "machine-path"
    if any(not re.search(r"(?:example|placeholder|your[-_]|[xX]{12})", match[0], re.I)
           for match in VENDOR_TOKEN.finditer(line)):
        yield "error", "provider-token"
    for match in AUTH_URL.finditer(line):
        username, separator, password = match[1].partition(":")
        host = match[2].casefold()
        local_default = (
            host in {"localhost", "127.0.0.1", "[::1]"}
            and (username, password) in {("postgres", "postgres"), ("guest", "guest")}
        )
        if separator and is_concrete(password) and not local_default:
            yield "review", "credential-literal"
            break
    if JWT.search(line):
        yield "review", "jwt-literal"
    if has_credential_literal(line, config_file):
        yield "review", "credential-literal"


def inspect_file(path, relative, args, findings):
    if path.name.casefold().endswith(OPAQUE_SUFFIXES):
        findings.add(Finding(relative, 0, "review", "opaque-archive"))
        return
    try:
        with path.open("rb") as stream:
            prefix = stream.read(4096)
            if prefix.startswith((b"SQLite format 3\0", b"PGDMP")) or re.match(rb"REDIS\d{4}", prefix):
                findings.add(Finding(relative, 0, "error", "runtime-database"))
                return
            if prefix.startswith((b"\xff\xfe", b"\xfe\xff")):
                encoding = "utf-16"
            elif b"\0" in prefix:
                known_synthetic_grib = (
                    relative == 'Test/algorithms/fixtures/grib2_t2m_2x2.grib2'
                    and prefix.startswith(b"GRIB")
                    and hashlib.sha256(prefix + stream.read()).hexdigest() == 'a030aa20f6813d46b801dd7044084737665905ed52be200f3278d1470f3f156d'
                )
                if path.suffix.casefold() not in KNOWN_BINARY_SUFFIXES and not known_synthetic_grib:
                    findings.add(Finding(relative, 0, "error", "unrecognized-binary-file"))
                return
            else:
                encoding = "utf-8-sig"
            limit = args.max_text_mib * 1024 * 1024
            payload = prefix + stream.read(limit + 1 - len(prefix))
        if len(payload) > limit:
            findings.add(Finding(relative, 0, "review", "oversized-text"))
            payload = payload[:limit]
        content = payload.decode(encoding, errors="replace")
    except (OSError, UnicodeError):
        findings.add(Finding(relative, 0, "error", "unreadable-file"))
        return

    for match in PRIVATE_KEY.finditer(content):
        findings.add(Finding(relative, content.count("\n", 0, match.start()) + 1, "error", "private-key"))
    name = path.name.casefold()
    if is_example(name):
        name = name.rsplit(".", 1)[0]
    config_file = is_env_filename(name) or Path(name).suffix in {".ini", ".cfg", ".conf", ".properties", ".yml", ".yaml", ".toml"}
    for number, line in enumerate(content.splitlines(), 1):
        for severity, code in line_checks(line, args, config_file):
            findings.add(Finding(relative, number, severity, code))


def audit(root, args):
    findings = set()
    source_directories = {root}
    readme_directories = set()
    file_count = 0
    stack = [root]
    while stack:
        directory = stack.pop()
        try:
            children = sorted(directory.iterdir())
        except OSError:
            findings.add(Finding(directory.relative_to(root).as_posix(), 0, "error", "unreadable-directory"))
            continue
        for path in children:
            relative = path.relative_to(root).as_posix()
            try:
                metadata = path.lstat()
            except OSError:
                findings.add(Finding(relative, 0, "error", "unreadable-entry"))
                continue
            if is_link(metadata):
                findings.add(Finding(relative, 0, "error", "linked-entry"))
                continue
            is_directory = stat.S_ISDIR(metadata.st_mode)
            blocked = forbidden(path.name, is_directory)
            if blocked:
                findings.add(Finding(relative, 0, "error", blocked))
                continue
            if is_directory:
                stack.append(path)
                continue
            if not stat.S_ISREG(metadata.st_mode):
                findings.add(Finding(relative, 0, "error", "unsupported-entry"))
                continue
            if path.name.casefold() in README_NAMES and metadata.st_size:
                readme_directories.add(directory)
            if is_source(path):
                source_directory = directory
                while source_directory not in source_directories:
                    source_directories.add(source_directory)
                    source_directory = source_directory.parent
            inspect_file(path, relative, args, findings)
            file_count += 1

    for directory in source_directories - readme_directories:
        findings.add(Finding(directory.relative_to(root).as_posix(), 0, "error", "missing-readme"))
    return sorted(findings), file_count, len(source_directories)


def main():
    args = parse_args()
    try:
        root_stat = args.root.lstat()
        if is_link(root_stat) or not stat.S_ISDIR(root_stat.st_mode):
            raise ValueError
        root = args.root.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        print("The staged root must be a readable directory without a link.", file=sys.stderr)
        return 2

    findings, file_count, directory_count = audit(root, args)
    report_items = []
    for finding in findings:
        item = asdict(finding)
        if finding.severity == "review" and (finding.code, finding.path) in args.review_exceptions:
            item["severity"] = "allowed-review"
        report_items.append(item)
    report = {
        "files_audited": file_count,
        "readme_directories_required": directory_count,
        "host_rules": len(args.host_patterns),
        "path_rules": len(args.path_patterns),
        "errors": sum(item["severity"] == "error" for item in report_items),
        "reviews": sum(item["severity"] == "review" for item in report_items),
        "allowed_reviews": sum(item["severity"] == "allowed-review" for item in report_items),
        "findings": report_items,
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=True, indent=2))
    else:
        for item in report_items:
            position = f":{item['line']}" if item["line"] else ""
            print(f"{item['severity']} {item['code']} {item['path']}{position}")
        print(f"{file_count} files, {directory_count} README directories, "
              f"{report['errors']} errors, {report['reviews']} unresolved reviews, "
              f"{report['allowed_reviews']} allowed reviews")
    return int(bool(report["errors"] or (args.fail_on_review and report["reviews"])))


if __name__ == "__main__":
    sys.exit(main())
