import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import uuid


class Failure(Exception):
    def __init__(self, message, code=1, **details):
        super().__init__(message)
        self.code, self.details = code, details


def run(argv, cwd=None, check=True, env=None, input=None):
    proc = subprocess.run([str(v) for v in argv], cwd=cwd, input=input,
                          text=True, capture_output=True, env=env)
    if check and proc.returncode:
        raise Failure(proc.stderr.strip() or proc.stdout.strip() or str(argv),
                      proc.returncode, command=[str(v) for v in argv])
    return proc


def git(path, *args, **kwargs):
    if "env" not in kwargs:
        kwargs["env"] = {k: v for k, v in os.environ.items() if k not in {"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"}}
    else:
        kwargs["env"] = {k: v for k, v in kwargs["env"].items() if k not in {"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"}}
    return run([os.environ["WB_REAL_GIT"], "-C", str(path), *args], **kwargs)


def atomic_write(path, text, mode=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(name, mode or (path.stat().st_mode & 0o777 if path.exists() else 0o600))
        os.replace(name, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def write_json(path, value):
    atomic_write(path, json.dumps(value, indent=2) + "\n")


@contextlib.contextmanager
def locked(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def identity():
    return "op-" + uuid.uuid4().hex


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


# pins.nix is data, not an executable API. Reject expressions/interpolation and
# parse only this literal subset; never evaluate contributor text to write pins.
TOKEN = re.compile(r'\s+|\#[^\n]*|"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z0-9_-]*|[0-9]+|[{}=;]')


def parse_pins(text):
    tokens, cursor = [], 0
    for match in TOKEN.finditer(text):
        if match.start() != cursor:
            raise Failure("pins.nix must contain literal data only", 2)
        token = match.group()
        cursor = match.end()
        if not token.isspace() and not token.startswith("#"):
            tokens.append(token)
    if text[cursor:].strip():
        raise Failure("unsupported pins.nix syntax", 2)
    position = 0

    def take(expected=None):
        nonlocal position
        if position >= len(tokens):
            raise Failure("incomplete pins.nix", 2)
        value = tokens[position]
        position += 1
        if expected is not None and value != expected:
            raise Failure("invalid pins.nix literal", 2)
        return value

    def value():
        if position >= len(tokens):
            raise Failure("incomplete pins.nix", 2)
        if tokens[position] == "{":
            take("{")
            result = {}
            while position < len(tokens) and tokens[position] != "}":
                key = take()
                if key.startswith('"'):
                    key = json.loads(key)
                if key in result:
                    raise Failure("duplicate pin key: " + key, 2)
                take("=")
                result[key] = value()
                take(";")
            take("}")
            return result
        token = take()
        if token == "null":
            return None
        if token.isdigit():
            return int(token)
        if token.startswith('"'):
            if "${" in token:
                raise Failure("Nix interpolation is forbidden in pins", 2)
            try:
                return json.loads(token)
            except ValueError as exc:
                raise Failure("pins use JSON-compatible quoted strings", 2) from exc
        raise Failure("pins.nix must contain literal data only", 2)

    result = value()
    if position != len(tokens) or not isinstance(result, dict) or result.get("schemaVersion") != 1:
        raise Failure("unsupported pins schema", 2)
    return result


def edit_pins(text, updates):
    old = parse_pins(text)
    for name, fields in updates.items():
        if name not in old["repositories"]:
            raise Failure("unknown pin: " + name, 2)
        block = re.compile(r'(^[ \t]*' + re.escape(name) + r'\s*=\s*\{)([^{}]*)(\})', re.MULTILINE)
        matches = list(block.finditer(text))
        if len(matches) != 1:
            raise Failure("pin entry must use a literal attribute block: " + name, 2)
        match = matches[0]
        body = match[2]
        for field, val in fields.items():
            replacement = json.dumps(val) if val is not None else "null"
            pattern = re.compile(r'(\b' + re.escape(field) + r'\s*=\s*)(?:"(?:\\.|[^"\\])*"|null)(\s*;)')
            if not list(pattern.finditer(body)) and field == "sourceUrl":
                body += "\n      sourceUrl = " + replacement + ";\n    "
                continue
            if len(list(pattern.finditer(body))) != 1:
                raise Failure("missing/ambiguous pin field: " + field, 2)
            body = pattern.sub(lambda m: m[1] + replacement + m[2], body)
        text = text[:match.start(2)] + body + text[match.end(2):]
    parsed = parse_pins(text)
    for name, fields in updates.items():
        if any(parsed["repositories"][name][k] != v for k, v in fields.items()):
            raise Failure("pin serialization verification failed")
    return text


def valid_sha(value):
    return isinstance(value, str) and re.fullmatch("[0-9a-f]{40}", value) is not None


def valid_ref(value):
    return (isinstance(value, str) and value.startswith("refs/heads/")
            and run([os.environ["WB_REAL_GIT"], "check-ref-format", value], check=False).returncode == 0)
