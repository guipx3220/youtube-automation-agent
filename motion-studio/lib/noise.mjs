// Seeded PRNG shared by the renderer and the audio builder. Never Math.random.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic value noise in [0, 1) for a given integer lattice point and seed.
export function hash1(n, seed = 0) {
  return mulberry32((n * 374761393 + seed * 668265263) >>> 0)();
}
