"""Consistent SQLite snapshot; never overwrite an existing destination."""
import argparse
import sqlite3
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
source, destination = args.source.resolve(), args.destination.resolve()
if not source.is_file():
    parser.error("Source database does not exist.")
if source == destination or destination.exists():
    parser.error("Destination must be a new file.")
destination.parent.mkdir(parents=True, exist_ok=True)
with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as db:
    with sqlite3.connect(destination) as backup:
        db.backup(backup)
        result = backup.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise RuntimeError("Database integrity check failed: " + result)
print("Database snapshot created and verified.")
