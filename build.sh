#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"
mkdir -p dist

python3 - <<'EOF'
import zipfile, os, json

with open('manifest.json') as f:
    version = json.load(f)['version']

files = [
    'manifest.json', 'config.js',
    'hook.js', 'content.js', 'background.js',
    'background/session-store.js',
    'background/identity-model.js',
    'background/probe-debug.js',
    'background/debug-log.js',
    'background/participant-mapping.js',
    'background/tag-join.js',
    'background/upload.js',
    'background/message-handlers.js',
    'popup.html', 'popup.js', 'popup.css',
    'viewer.html', 'viewer.js', 'viewer.css',
]

out = f'dist/meet-capture-mentor-v{version}.zip'
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in files:
        z.write(f)
        print(f'  + {f}')

print(f'\nBuilt: {out}')
EOF

echo ""
echo "Install steps for mentors:"
echo "  1. Open chrome://extensions in Chrome"
echo "  2. Enable 'Developer mode' (top-right toggle)"
echo "  3. Drag dist/meet-capture-mentor.zip onto the page"
