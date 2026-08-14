#!/usr/bin/env python3
import argparse
import hashlib
import stat
import tarfile
import zipfile
from pathlib import Path


def digest_stream(stream) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    while chunk := stream.read(1024 * 1024):
        size += len(chunk)
        digest.update(chunk)
    return size, digest.hexdigest()


def add_record(records, name: str, kind: str, size: int, digest: str):
    if name in records:
        raise ValueError(f"duplicate archive member: {name}")
    records[name] = (kind, size, digest)


def zip_records(archive: Path):
    records = {}
    with zipfile.ZipFile(archive) as source:
        for member in source.infolist():
            mode = member.external_attr >> 16
            if member.is_dir():
                add_record(records, member.filename, "directory", 0, "")
                continue
            kind = "symlink" if stat.S_ISLNK(mode) else "file"
            with source.open(member) as payload:
                size, digest = digest_stream(payload)
            add_record(records, member.filename, kind, size, digest)
    return records


def tar_records(archive: Path):
    records = {}
    with tarfile.open(archive, "r:gz") as source:
        for member in source:
            if member.isdir():
                add_record(records, member.name, "directory", 0, "")
            elif member.issym() or member.islnk():
                payload = member.linkname.encode()
                add_record(
                    records,
                    member.name,
                    "symlink" if member.issym() else "hardlink",
                    len(payload),
                    hashlib.sha256(payload).hexdigest(),
                )
            elif member.isfile():
                extracted = source.extractfile(member)
                if extracted is None:
                    raise ValueError(f"could not read archive member: {member.name}")
                with extracted:
                    size, digest = digest_stream(extracted)
                add_record(records, member.name, "file", size, digest)
            else:
                raise ValueError(f"unsupported archive member: {member.name}")
    return records


def archive_records(archive: Path):
    if archive.name.endswith(".zip"):
        return zip_records(archive)
    if archive.name.endswith(".tar.gz"):
        return tar_records(archive)
    raise ValueError(f"unsupported archive format: {archive}")


def content_digest(records) -> str:
    digest = hashlib.sha256()
    for name in sorted(records):
        kind, size, member_digest = records[name]
        for value in (name, kind, str(size), member_digest):
            encoded = value.encode()
            digest.update(len(encoded).to_bytes(8, "big"))
            digest.update(encoded)
    return digest.hexdigest()


def compare(first: Path, second: Path) -> str:
    first_records = archive_records(first)
    second_records = archive_records(second)
    if first_records != second_records:
        differing = sorted(
            name
            for name in first_records.keys() | second_records.keys()
            if first_records.get(name) != second_records.get(name)
        )
        detail = "\n".join(f"  {name}" for name in differing[:50])
        if len(differing) > 50:
            detail += f"\n  ... and {len(differing) - 50} more"
        raise ValueError(f"archive content mismatch in {len(differing)} member(s):\n{detail}")
    return content_digest(first_records)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("first", type=Path)
    parser.add_argument("second", type=Path)
    args = parser.parse_args()
    try:
        print(compare(args.first.resolve(), args.second.resolve()))
    except (OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
