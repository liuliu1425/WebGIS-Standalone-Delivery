"""Load the bundled synthetic layer directories into the new deployment only."""
from pathlib import Path
import re
import shutil

SOURCE = Path("/fixtures/imports")
TARGET = Path("/runtime/output/imports")

def main():
    if not SOURCE.is_dir():
        raise FileNotFoundError("Generate the synthetic samples before loading them")
    TARGET.mkdir(parents=True, exist_ok=True)
    candidates = sorted(path for path in SOURCE.iterdir() if path.name != "README.md")
    if not candidates:
        raise FileNotFoundError("Synthetic sample imports are empty")
    for sample in candidates:
        if sample.is_symlink() or not sample.is_dir() or not re.fullmatch(r"imported-[0-9a-f]{12}", sample.name):
            raise ValueError(f"Unexpected synthetic sample directory: {sample.name}")
        if any(p.is_symlink() for p in sample.rglob("*")):
            raise ValueError("Synthetic sample symlinks are unsupported")
        output = TARGET / sample.name
        if output.exists():
            print(f"Keep existing sample data: {sample.name}")
            continue
        shutil.copytree(sample, output)
        print(f"Loaded synthetic sample: {sample.name}")

if __name__ == "__main__":
    main()
