import typescript from 'rollup-plugin-typescript2'
import replace from '@rollup/plugin-replace'
import { dye } from '@prostojs/dye'
import { nodeResolve } from '@rollup/plugin-node-resolve'
import commonJS from '@rollup/plugin-commonjs'
import { dts } from 'rollup-plugin-dts'

const dyeModifiers = [
    'dim',
    'bold',
    'underscore',
    'inverse',
    'italic',
    'crossed',
    'gray01',
    'gray02',
    'gray03',
]
const dyeColors = [
    'red',
    'green',
    'cyan',
    'blue',
    'yellow',
    'white',
    'magenta',
    'black',
]

const external = ['url', 'crypto', 'stream', 'packages/*/src', 'http', 'path']

const replacePlugin = replace({
    values: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        ...createDyeReplaceConst(),
    },
    preventAssignment: true,
})

const configs = [createConfig('mjs'), createConfig('cjs'), createDtsConfig()]

function createConfig(type) {
    const formats = {
        cjs: 'cjs',
        mjs: 'es',
    }
    return {
        external,
        input: `./src/index.ts`,
        output: {
            file: `./dist/index.${type}`,
            format: formats[type],
            sourcemap: false,
        },
        plugins: [
            commonJS({ sourceMap: false }),
            nodeResolve(),
            typescript({
                check: true,
                tsconfig: 'tsconfig.json',
                tsconfigOverride: {
                    target: 'es2020',
                    declaration: false,
                    declarationMap: false,
                    removeComments: true,
                    include: [
                        'src',
                    ],
                    exclude: ['**/__tests__', '*.spec.ts', 'explorations'],
                },
            }),
            replacePlugin,
        ],
    }
}

function createDtsConfig() {
    return {
        external,
        input: `./src/index.ts`,
        output: {
            file: `./dist/index.d.ts`,
            format: 'es',
            sourcemap: false,
        },
        plugins: [dts({
            tsconfig: 'tsconfig.json',
            compilerOptions: {
                removeComments: false,
            }
        })],
    }
}

export default configs

function createDyeReplaceConst() {
    const c = dye('red')
    const bg = dye('bg-red')
    const dyeReplacements = {
        __DYE_RESET__: "'" + dye.reset + "'",
        __DYE_COLOR_OFF__: "'" + c.close + "'",
        __DYE_BG_OFF__: "'" + bg.close + "'",
    }
    dyeModifiers.forEach((v) => {
        dyeReplacements[`__DYE_${v.toUpperCase()}__`] = "'" + dye(v).open + "'"
        dyeReplacements[`__DYE_${v.toUpperCase()}_OFF__`] =
            "'" + dye(v).close + "'"
    })
    dyeColors.forEach((v) => {
        dyeReplacements[`__DYE_${v.toUpperCase()}__`] = "'" + dye(v).open + "'"
        dyeReplacements[`__DYE_BG_${v.toUpperCase()}__`] =
            "'" + dye('bg-' + v).open + "'"
        dyeReplacements[`__DYE_${v.toUpperCase()}_BRIGHT__`] =
            "'" + dye(v + '-bright').open + "'"
        dyeReplacements[`__DYE_BG_${v.toUpperCase()}_BRIGHT__`] =
            "'" + dye('bg-' + v + '-bright').open + "'"
    })
    return dyeReplacements
}
