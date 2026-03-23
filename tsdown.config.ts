import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: ['src/index.ts', 'src/outlets/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
});
