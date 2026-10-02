# Migration to agy-retry-hud v0.5.0

## From v0.4.x

v0.5.0 keeps the existing native state/config format compatible while adding daemon ownership.

### Preserved

- global retry/handoff settings;
- conversation overrides;
- pending retry deadlines and counters;
- portable/local handoffs;
- exact conversation binding and multi-CLI guards.

### Changed

- one singleton daemon owns waiting retry orchestration;
- old detached workers are superseded by rebinding waiting incident IDs on daemon adoption;
- config gains `daemon`, `hud.enabled`, and `hud.visible` defaults;
- three skills are added: `hud-control`, `daemon-control`, `doctor`.

### Upgrade

```bash
agy plugin uninstall agy-retry-hud
# install/extract the v0.5 plugin
node ./agy-retry-hud/setup.js install --force-statusline
agy-retryctl setup repair --json
agy-retryctl doctor --json
```

No systemd/launchd/Windows Service setup is required.


## v0.5.1

No state migration is required from v0.5.0. Reinstall/repair the plugin so `dist/native-entry.js`, `dist/native.js`, and `dist/daemon.js` are replaced.
