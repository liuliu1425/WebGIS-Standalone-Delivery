"""Create a private deployment configuration outside the source tree."""
import argparse
import os
from pathlib import Path
import re
import secrets

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--admin", default="local-admin")
    parser.add_argument("--port", default=25175, type=int)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{2,31}", args.admin):
        parser.error("Supply an administrator name of 3–32 letters, digits, underscores or hyphens")
    if args.port < 1024 or args.port > 65535 or args.port in (5175, 8000, 15175):
        parser.error("Supply an independent high port")
    source_root = Path(__file__).resolve().parent.parent
    dest = args.output.expanduser().resolve()
    if dest.is_relative_to(source_root):
        parser.error("Store the runtime configuration outside the source tree")
    dest.parent.mkdir(parents=True, exist_ok=True)
    admin_pass = "A9-" + secrets.token_urlsafe(24)
    values = {
        "DELIVERY_HTTP_PORT": str(args.port),
        "DELIVERY_ADMIN_USER": args.admin,
        "DELIVERY_ADMIN_PASSWORD": admin_pass,
        "DELIVERY_ENCRYPTION_KEY": secrets.token_hex(32),
        "DELIVERY_SERVICE_KEY": secrets.token_urlsafe(32),
        "DELIVERY_MINIO_USER": "local-" + secrets.token_hex(6),
        "DELIVERY_MINIO_PASSWORD": secrets.token_urlsafe(30),
    }
    with os.fdopen(os.open(dest, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w", encoding="utf-8", newline="\n") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")
    print(f"Created private settings at {dest}")

if __name__ == "__main__":
    main()
