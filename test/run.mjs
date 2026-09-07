// Both suites, offline, no network. The renderer suite needs playwright and
// skips cleanly without it; nothing here reaches past this machine.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function run(file) {
    return new Promise((resolve) => {
        console.log('\n' + file);
        const child = spawn(process.execPath, [path.join(here, file)], { stdio: 'inherit' });
        child.on('close', (code) => resolve(code === 0));
    });
}

const ok = [];
ok.push(await run('main.test.cjs'));
ok.push(await run('renderer.test.mjs'));

const failed = ok.filter((x) => !x).length;
console.log(failed ? '\n' + failed + ' suite(s) failed' : '\nall suites passed');
process.exit(failed ? 1 : 0);
