#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"
mkdir -p dist

python3 - <<'EOF'
import zipfile, os

files = [
    'manifest.json', 'config.js',
    'hook.js', 'content.js', 'background.js',
    'popup.html', 'popup.js', 'popup.css',
    'viewer.html', 'viewer.js', 'viewer.css',
]

out = 'dist/meet-capture-mentor.zip'
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
