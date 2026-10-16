#!/usr/bin/env python3
"""Reassemble raw split artifacts and extract UnityWebData plus control evidence.

Run from the repository root. Outputs stay in ignored .analysis/. Install
UnityPy==1.25.4 in a local venv for --controls; basic extraction is stdlib-only.
This is archive extraction, not decryption or C# source recovery.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def extract(root, output, controls=False):
    output.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for kind, count in [('data', 6), ('wasm', 3)]:
        parts = []
        destination = output / f'PPG.{kind}'
        with destination.open('wb') as target:
            for index in range(1, count + 1):
                source = root / f'Build/PPG.{kind}.part{index}'
                data = source.read_bytes()
                target.write(data)
                parts.append({'path': str(source.relative_to(root)), 'bytes': len(data), 'sha256': sha256(data)})
        data = destination.read_bytes()
        manifest[kind] = {'parts': parts, 'bytes': len(data), 'sha256': sha256(data)}

    data = (output / 'PPG.data').read_bytes()
    if data[:16] != b'UnityWebData1.0\0':
        raise ValueError('Not a UnityWebData1.0 archive')
    header_end = struct.unpack_from('<I', data, 16)[0]
    if not 20 <= header_end <= len(data):
        raise ValueError('Invalid archive header bounds')
    position = 20
    entries = []
    names = set()
    while position < header_end:
        if position + 12 > header_end:
            raise ValueError('Truncated directory entry')
        offset, size, length = struct.unpack_from('<III', data, position)
        position += 12
        if position + length > header_end:
            raise ValueError('Truncated entry name')
        name = data[position:position + length].decode('utf-8')
        position += length
        relative = Path(name)
        if not name or relative.is_absolute() or '..' in relative.parts or '\\' in name or name in names:
            raise ValueError(f'Unsafe or duplicate archive path: {name!r}')
        names.add(name)
        if offset < header_end or offset + size > len(data):
            raise ValueError(f'Invalid entry bounds: {name}')
        destination = output / 'extracted' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        payload = data[offset:offset + size]
        destination.write_bytes(payload)
        entries.append({'path': name, 'offset': offset, 'bytes': size, 'sha256': sha256(payload)})
    manifest['data_entries'] = entries

    metadata = (output / 'extracted/Il2CppData/Metadata/global-metadata.dat').read_bytes()
    magic, version = struct.unpack_from('<II', metadata)
    if magic != 0xFAB11BAF:
        raise ValueError('IL2CPP metadata does not have the expected unencrypted magic')
    manifest['metadata'] = {'magic': hex(magic), 'version': version, 'bytes': len(metadata)}
    if controls:
        import UnityPy
        bundle = output / 'extracted/data.unity3d'
        environment = UnityPy.load(str(bundle))
        candidates = []
        for obj in environment.objects:
            if obj.type.name != 'TextAsset':
                continue
            asset = obj.parse_as_object()
            if asset.m_Name == 'default_controls':
                text = asset.m_Script.encode('utf-8', 'surrogateescape')
                parsed = json.loads(text)
                candidates.append((obj, text, parsed))
        if len(candidates) != 1:
            raise ValueError(f'Expected one default_controls TextAsset, found {len(candidates)}')
        obj, text, parsed = candidates[0]
        (output / 'default_controls.json').write_bytes(text)
        manifest['controls'] = {
            'tool': 'UnityPy', 'version': UnityPy.__version__, 'path_id': obj.path_id,
            'asset_name': 'default_controls', 'asset_sha256': sha256(text),
            'bundle_sha256': sha256(bundle.read_bytes()), 'action_count': len(parsed),
            'unity_version': '.'.join(str(part) for part in obj.version),
        }
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--controls', action='store_true', help='Extract default_controls using UnityPy==1.25.4')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    result = extract(root, root / '.analysis', args.controls)
    print(json.dumps(result, indent=2))
