import fs from "node:fs";
import path from "node:path";

import {
  ROOT,
  SCORE_CONTRACT_NAME,
  SCORE_SOURCE_NAME,
  buildArtifact,
  compileInput,
  createCompilerInput,
  getCompiledContract,
} from "./contract-build-config.mjs";

const input = createCompilerInput();
const { output } = compileInput(input);
const compiled = getCompiledContract(output, SCORE_SOURCE_NAME, SCORE_CONTRACT_NAME);
const source = input.sources[SCORE_SOURCE_NAME].content;
const artifact = buildArtifact(compiled, source);

const artifactDirectory = path.join(ROOT, "artifacts");
fs.mkdirSync(artifactDirectory, { recursive: true });
fs.writeFileSync(
  path.join(artifactDirectory, "BlockstepScores.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
);
console.log(
  `Compiled BlockstepScores (${artifact.build.creationBytes} deployment bytes, ${artifact.build.runtimeBytes} runtime bytes, ${artifact.build.creationCodeHash})`,
);
