// Shared fake `docker` for CLI tests: --version, inspect, exec.
// - `exec ... /usage` → canned quota JSON (agy-a exhausted, others 70%)
// - `exec agy-a agy` (session) → prints a quota signal, exits on "/exit"
// - other session execs → exit 0 after 1.5s idle, or on "/exit"
import fs from 'node:fs';
import path from 'node:path';

const SCRIPT = [
  '#!/bin/bash',
  'case "$1" in',
  '  --version) echo "Docker version 99.0.0, build fake"; exit 0;;',
  '  inspect) echo "true"; exit 0;;',
  '  exec)',
  '    shift',
  '    while [[ "$1" == -* ]]; do shift; done',
  '    container="$1"; shift',
  '    case "$*" in *"/usage"*)',
  '      if [[ "$container" == "agy-a" ]]; then',
  "        echo '{\"quota\":{\"x 5h\":{\"remaining_fraction\":0,\"reset_in_seconds\":3600}}}'",
  '      else',
  "        echo '{\"quota\":{\"x 5h\":{\"remaining_fraction\":0.7,\"reset_in_seconds\":3600}}}'",
  '      fi',
  '      exit 0;;',
  '    esac',
  '    if [[ "$container" == "agy-a" ]]; then',
  '      sleep 0.5',
  '      echo "Error 429: RESOURCE_EXHAUSTED"',
  '    fi',
  '    # other sessions: exit 0 after 4s idle (natural session end), or on "/exit"',
  '    while true; do',
  '      if IFS= read -t 4 -r line; then',
  '        [[ "$line" == "/exit" ]] && exit 0',
  '      else',
  '        exit 0',
  '      fi',
  '    done',
  '    ;;',
  '  *) echo "fake-docker: unknown command: $1" >&2; exit 1;;',
  'esac',
].join('\n');

export function installFakeDocker(dir) {
  const binDir = path.join(dir, 'fakebin');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'docker'), SCRIPT + '\n', { mode: 0o755 });
  return binDir;
}
