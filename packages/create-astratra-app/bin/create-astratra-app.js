#!/usr/bin/env node
import { createProject, parseArgs } from '../src/createProject.js';

try {
  const options = parseArgs(process.argv.slice(2));
  const result = createProject(options);
  console.log(`Astratra app created in ${result.targetDir}`);
  console.log('');
  console.log('Next steps:');
  for (const command of result.nextSteps) {
    console.log(`  ${command}`);
  }
} catch (error) {
  console.error(`create-astratra-app: ${error.message}`);
  process.exit(1);
}
