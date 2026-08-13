import fs from "node:fs";
import path from "node:path";

import { keccak256, toHex } from "viem";

import {
  COMPILER_SETTINGS,
  ROOT,
  SCORE_CONTRACT_NAME,
  SCORE_SOURCE_NAME,
  buildArtifact,
  compileInput,
  compilerVersion,
  createCompilerInput,
  getCompiledContract,
} from "./contract-build-config.mjs";

const input = createCompilerInput();
const { output, diagnostics } = compileInput(input);
const compiled = getCompiledContract(output, SCORE_SOURCE_NAME, SCORE_CONTRACT_NAME);
const source = input.sources[SCORE_SOURCE_NAME].content;
const artifact = buildArtifact(compiled, source);
const parsedMetadata = JSON.parse(compiled.metadata);

const bundleDirectory = path.join(ROOT, "artifacts", "contract-verification");
fs.mkdirSync(bundleDirectory, { recursive: true });

const files = {
  "BlockstepScores.standard-input.json": `${JSON.stringify(input, null, 2)}\n`,
  "BlockstepScores.metadata.json": `${JSON.stringify(parsedMetadata, null, 2)}\n`,
  "BlockstepScores.abi.json": `${JSON.stringify(compiled.abi, null, 2)}\n`,
  "BlockstepScores.artifact.json": `${JSON.stringify(artifact, null, 2)}\n`,
};

for (const [name, content] of Object.entries(files)) {
  fs.writeFileSync(path.join(bundleDirectory, name), content);
}

const manifest = {
  status: "local verification bundle only; no deployment performed",
  chainId: 43111,
  contract: `${SCORE_SOURCE_NAME}:${SCORE_CONTRACT_NAME}`,
  constructorArguments: [],
  compiler: compilerVersion(),
  settings: COMPILER_SETTINGS,
  sourceHash: artifact.build.sourceHash,
  creationCodeHash: artifact.build.creationCodeHash,
  runtimeTemplateCodeHash: artifact.build.runtimeTemplateCodeHash,
  immutableReferences: artifact.build.immutableReferences,
  creationBytes: artifact.build.creationBytes,
  runtimeBytes: artifact.build.runtimeBytes,
  abiHash: keccak256(toHex(JSON.stringify(compiled.abi))),
  diagnostics: diagnostics.map(({ severity, errorCode, type, message }) => ({
    severity,
    errorCode: errorCode ?? null,
    type,
    message,
  })),
  files: Object.keys(files),
  explorerVerification: {
    preferredMethod: "Solidity Standard JSON Input",
    apiUrl: "https://explorer.hemi.xyz/api",
    browserUrl: "https://explorer.hemi.xyz",
    note: "Use the exact compiler and settings in this manifest; do not copy generic optimizer defaults.",
  },
};

fs.writeFileSync(
  path.join(bundleDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log(`Verification bundle: ${bundleDirectory}`);
console.log(`Compiler: ${manifest.compiler}`);
console.log(`Settings: optimizer=200, viaIR=true, evmVersion=${manifest.settings.evmVersion}`);
console.log(`Creation code: ${manifest.creationBytes} bytes ${manifest.creationCodeHash}`);
console.log(`Runtime template: ${manifest.runtimeBytes} bytes ${manifest.runtimeTemplateCodeHash}`);
