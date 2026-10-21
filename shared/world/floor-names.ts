// Mock project names for Habblaud World: each floor in a building gets an ID
// from this list ("ipe", "jade", "aurora"...), randomized by server from random floor ID, and the
// visitor's browser translates ("Project Ipê", "Project Ipê", "Proyecto Ipê", "Projet Ipê"). The label changes
// along with floor ID (24 h ± 6 h rotation), so it never identifies any real project.
//
// ASCII-only IDs, neutral and trademark-free: 20 trees, 20 stones, and 20 constellations (plus aurora). The order
// affects the draw (index = hash of floor ID): do not reorder or remove items; appending at the end only shifts draws of
// new floors after the next rotation.
//
// Self-contained file (no imports), to be copied identically between repositories. Source is public
// (shared/world/floor-names.ts, with translated labels via tr() in shared/world/floor-labels.ts); world server
// retains exact copy (protocol/floor-names.ts, with hash verified by test).

export const FLOOR_NAME_IDS = [
  // Trees
  'ipe', 'jacaranda', 'jatoba', 'peroba', 'cedro', 'aroeira', 'araucaria', 'buriti', 'carnauba', 'figueira',
  'oliveira', 'carvalho', 'salgueiro', 'sequoia', 'baoba', 'acacia', 'magnolia', 'cerejeira', 'pinheiro', 'palmeira',
  // Stones
  'jade', 'ambar', 'ametista', 'quartzo', 'topazio', 'turmalina', 'agata', 'onix', 'opala', 'safira',
  'rubi', 'esmeralda', 'granada', 'jaspe', 'malaquita', 'obsidiana', 'turquesa', 'citrino', 'peridoto', 'lapislazuli',
  // Constellations (and aurora)
  'aurora', 'orion', 'lyra', 'cygnus', 'draco', 'andromeda', 'cassiopeia', 'perseus', 'phoenix', 'hydra',
  'aquila', 'carina', 'vela', 'centaurus', 'crux', 'pavo', 'columba', 'auriga', 'lupus', 'tucana',
] as const;

export type FloorNameId = (typeof FLOOR_NAME_IDS)[number];
