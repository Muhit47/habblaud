#!/usr/bin/env node
// Legacy permission hook path. Up to 0.2.0, `npm run hooks:install` wrote this file to accounts' settings.json;
// the script moved to mod/habblaud-permissoes/hooks/permission-hook.mjs (the habblaud-permissoes plugin).
// This shortcut keeps existing installs functional after `git pull`, until `npm run mod:install` runs (which removes
// the legacy hook) or a new `npm run hooks:install` replaces them. Pure Node, zero dependencies.
import { main } from '../mod/habblaud-permissoes/hooks/permission-hook.mjs';

main().catch(() => process.exit(0));
