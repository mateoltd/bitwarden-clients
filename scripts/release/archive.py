#!/usr/bin/env python3
import argparse
import gzip
import os
import shutil
import stat
import tarfile
import zipfile
from pathlib import Path


def entries(root: Path):
    return sorted((item for item in root.rglob("*") if item != root), key=lambda item: item.as_posix())


def normalized_mode(item: Path) -> int:
    if item.is_dir():
        return 0o755
    return 0o755 if os.access(item, os.X_OK) else 0o644


def create_zip(source: Path, output: Path, epoch: int):
    timestamp = __import__("datetime").datetime.fromtimestamp(max(epoch, 315532800), __import__("datetime").timezone.utc)
    date_time = (timestamp.year, timestamp.month, timestamp.day, timestamp.hour, timestamp.minute, timestamp.second)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for item in entries(source):
            relative = item.relative_to(source).as_posix()
            if item.is_dir():
                relative += "/"
            info = zipfile.ZipInfo(relative, date_time=date_time)
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            if item.is_symlink():
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
                archive.writestr(info, os.readlink(item).encode())
            elif item.is_dir():
                info.external_attr = (stat.S_IFDIR | 0o755) << 16
                archive.writestr(info, b"")
            else:
                info.external_attr = (stat.S_IFREG | normalized_mode(item)) << 16
                archive.writestr(info, item.read_bytes())


def create_tar(source: Path, output: Path, epoch: int):
    with output.open("wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=epoch, compresslevel=9) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for item in entries(source):
                    relative = item.relative_to(source).as_posix()
                    info = archive.gettarinfo(str(item), arcname=relative)
                    info.uid = info.gid = 0
                    info.uname = info.gname = "root"
                    info.mtime = epoch
                    info.mode = normalized_mode(item)
                    if info.isfile():
                        with item.open("rb") as payload:
                            archive.addfile(info, payload)
                    else:
                        archive.addfile(info)


def extract(archive: Path, destination: Path):
    destination.mkdir(parents=True, exist_ok=True)
    resolved = destination.resolve()
    if archive.name.endswith(".zip"):
        with zipfile.ZipFile(archive) as source:
            for member in source.infolist():
                target = (destination / member.filename).resolve()
                if resolved not in target.parents and target != resolved:
                    raise ValueError(f"unsafe archive member: {member.filename}")
            source.extractall(destination)
            for member in source.infolist():
                target = destination / member.filename
                mode = member.external_attr >> 16
                if target.exists() and not target.is_dir() and mode:
                    target.chmod(stat.S_IMODE(mode))
    else:
        with tarfile.open(archive, "r:gz") as source:
            source.extractall(destination, filter="data")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source")
    parser.add_argument("--output", required=True)
    parser.add_argument("--format", choices=("zip", "tar.gz"))
    parser.add_argument("--epoch", type=int)
    parser.add_argument("--extract", action="store_true")
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if args.extract:
        extract(Path(args.source).resolve(), output)
    else:
        if not args.format or args.epoch is None:
            parser.error("--format and --epoch are required when creating an archive")
        source = Path(args.source).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        if args.format == "zip":
            create_zip(source, output, args.epoch)
        else:
            create_tar(source, output, args.epoch)


if __name__ == "__main__":
    main()
