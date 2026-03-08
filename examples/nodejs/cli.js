#!/usr/bin/env node
import { createRKDevelopToolWrapper } from '../../src/rkdeveloptool-wrapper.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error('Usage: node examples/nodejs/cli.js <command> [args...]');
    process.exit(1);
  }

  const wrapper = await createRKDevelopToolWrapper({
    runtime: 'node',
    onStdout: (line) => {
      process.stdout.write(`${line}\n`);
    },
    onStderr: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });

  const result = await wrapper.runCommand(args);
  process.exitCode = result.exitCode;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
