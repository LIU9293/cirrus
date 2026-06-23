// Backward-compatibility shim. Miniapps generated before the terr→cirrus rename
// import their host hooks from "@/terrui" (e.g. useTerr, useTerrState). The module
// is now cirrusui.tsx; re-export everything here, plus the old hook names, so those
// existing miniapp sources still build.
export * from './cirrusui'
export { useCirrus as useTerr, useCirrusState as useTerrState } from './cirrusui'
