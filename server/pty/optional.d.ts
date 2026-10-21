// Optional dependencies for interactive terminal (optionalDependencies): dynamically loaded via import()
// and referenced only by local types (manager.ts, screen.ts). Declared here so typecheck passes without installation.
declare module 'node-pty';
declare module '@xterm/headless';
declare module '@xterm/addon-serialize';
