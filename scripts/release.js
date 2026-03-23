import { execSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import semver from 'semver';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
const version = pkg.version;

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry');
const skipTests = args.includes('--skipTests');
const skipBuild = args.includes('--skipBuild');

const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const red = (s) => `\x1b[91m${s}\x1b[0m`;
const green = (s) => `\x1b[32m\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[32m\x1b[2m${s}\x1b[0m`;

const step = (msg) => console.log(`\n${cyan(msg)}`);
const error = (msg) => console.error(red(msg));
const good = (msg) => console.log(`\n${green(`✓ ${msg}`)}`);
const info = (msg) => console.log(dim(msg));

function run(bin, args) {
    execFileSync(bin, args, { stdio: 'inherit' });
}

function exec(cmd) {
    return execSync(cmd, { encoding: 'utf8' }).trim();
}

async function ask(question, choices) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    if (choices) {
        console.log(`\n${question}`);
        choices.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
        const answer = await new Promise((resolve) => rl.question('> ', resolve));
        rl.close();
        const idx = parseInt(answer, 10) - 1;
        if (idx < 0 || idx >= choices.length) throw new Error('Invalid choice');
        return choices[idx];
    }
    const answer = await new Promise((resolve) => rl.question(`${question} (y/N) `, resolve));
    rl.close();
    return answer.toLowerCase() === 'y';
}

const branch = exec('git branch --show-current');
const commitMessage = exec('git log -1 --pretty=%B');
const gitStatus = exec('git status');

if (!gitStatus.includes('nothing to commit, working tree clean')) {
    error('Please commit all the changes first.');
    process.exit(1);
}

const inc = (i) => {
    if (['prerelease', 'premajor'].includes(i.split(' ')[0])) {
        const [action, pre] = i.split(' ');
        return semver.inc(version, action, pre);
    }
    return semver.inc(version, i);
};

async function main() {
    let targetVersion = version;
    if (branch !== 'main') {
        error('Branch "main" expected');
        process.exit(1);
    }

    const versionIncrements = [
        'patch',
        'minor',
        'prerelease alpha',
        'prerelease beta',
        'preminor alpha',
        'preminor beta',
        'premajor alpha',
        'premajor beta',
        'major',
    ];

    const choices = versionIncrements.map((i) => `${i} (${inc(i)})`);
    const release = await ask('Select release type:', choices);

    targetVersion = release.match(/\((.*)\)/)[1];

    if (!semver.valid(targetVersion)) {
        throw new Error(`invalid target version: ${targetVersion}`);
    }

    const yes = await ask(`Releasing v${targetVersion}. Confirm?`);
    if (!yes) return;

    step('Running tests...');
    if (!skipTests && !isDryRun) {
        run('npm', ['test']);
    } else {
        info('(skipped)');
    }

    step('Running lint...');
    if (!skipTests && !isDryRun) {
        run('npm', ['run', 'lint']);
    } else {
        info('(skipped)');
    }

    step('Building package...');
    if (!skipBuild && !isDryRun) {
        run('npm', ['run', 'build']);
    } else {
        info('(skipped)');
    }

    const npmAction = release.split(' ')[0];
    const pre = release.split(' ')[1];
    const preAction = ['prerelease', 'preminor', 'premajor'].includes(npmAction)
        ? ['--preid', pre]
        : [];

    step(`Creating a new version ${targetVersion} ...`);
    run('npm', ['version', npmAction, ...preAction, '-m', commitMessage]);

    step('Pushing changes ...');
    run('git', ['push']);

    step('Pushing tags ...');
    run('git', ['push', '--tags']);

    step('Publishing ...');
    run('npm', ['publish', '--access', 'public']);

    good('All done!');
}

main().catch((e) => {
    error(e.message);
    process.exit(1);
});
