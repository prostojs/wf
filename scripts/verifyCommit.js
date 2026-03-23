import { readFileSync } from 'node:fs';

const msgPath = process.env.GIT_PARAMS;
const msg = readFileSync(msgPath, 'utf-8').trim();

const commitRE =
    /^(revert: )?(feat|fix|docs|dx|style|refactor|perf|test|workflow|build|ci|chore|types|wip|release)(\(.+\))?: .{1,50}/;

if (!commitRE.test(msg)) {
    console.error(
        `\n  \x1b[41m\x1b[37m\x1b[1m ERROR \x1b[0m \x1b[31minvalid commit message format.\x1b[0m\n\n` +
            `\x1b[31m  Proper commit message format is required for automated changelog generation. Examples:\n\n\x1b[0m` +
            `    \x1b[32mfeat(compiler): add 'comments' option\x1b[0m\n` +
            `    \x1b[32mfix(v-model): handle events on blur (close #28)\x1b[0m\n\n` +
            `\x1b[31m  See .github/commit-convention.md for more details.\n\x1b[0m`,
    );
    process.exit(1);
}
